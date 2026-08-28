import { type LLMPort, retryDispositionForKind, type StreamEvent, type StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import type { LlmSurfaceId, LlmTransportId } from "@/shared/llm-route-types"
import type { ErrorClassifier, RetryRouter } from "./error-routing"
import { sleep as abortAwareSleep } from "./loop/sleep"

/**
 * `LLMPort` decorator adding bounded exponential-backoff retry around a flaky
 * inner port. RFC-minimal: a single tier, no circuit breaker, no per-error
 * budget — just "retry transient pre-stream failures, never duplicate output".
 *
 * Retry contract:
 * - Only the *connection* phase is retried. If the inner stream throws BEFORE
 *   yielding its first event we may safely restart it. Once ≥1 event has been
 *   yielded a mid-stream failure is RETHROWN (retrying would re-emit already
 *   consumed deltas / tool_use blocks → corrupt transcript).
 * - Classification (see {@link isRetryable}): transient network / overload /
 *   rate-limit / 5xx errors retry; auth / 400 / 404 / malformed do not.
 * - Backoff is exponential with full jitter: delay ∈ [0, min(cap, base*2^n)].
 * - The abort signal is honored both while waiting and between attempts: the
 *   default backoff sleep is the abort-aware sleep from `./loop/sleep` (when
 *   a `signal` is wired), which resolves early on abort so the loop's
 *   post-sleep abort check surfaces the typed `aborted` error promptly
 *   instead of finishing a (up to 60s) backoff timer first.
 *
 * `sleep` and `random` are injectable so tests are deterministic. When a
 * custom `sleep` is injected, honoring the abort signal while waiting is the
 * injector's responsibility.
 */
export interface RetryingLLMOptions {
  inner: LLMPort
  maxRetries?: number
  baseDelayMs?: number
  signal?: AbortSignal
  /** Injectable for deterministic tests. Defaults to the abort-aware sleep
   *  (`./loop/sleep`) bound to `signal` when one is provided — abort during
   *  a backoff wakes the loop immediately — else a plain timer (no signal ⇒
   *  nothing to honor). An injected sleep must handle abort itself. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  random?: () => number
  /** ADR-0203 wire (opt-in) — when set, the wrapper consults the typed
   *  error-routing slice as an ADDITIONAL refinement on top of `isRetryable`:
   *  - `abort` / `hitl` ⇒ rethrow immediately (skip backoff, never retry),
   *  - `retry-same-turn` / `retry-with-backoff` / `swap-fallback` ⇒ honor
   *     the legacy `isRetryable` path (defense-in-depth: typed slice agrees
   *     it's retry-eligible AND legacy markers also vote retry).
   *  Default-OMIT: when absent, the legacy `isRetryable`-only path runs
   *  byte-identically (no classifier call, no router call, no allocation). */
  errorRouting?: { readonly classifier: ErrorClassifier; readonly router: RetryRouter }
}

const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BASE_DELAY_MS = 500
/** Backoff ceiling (~15s) regardless of attempt count. Applies ONLY to the
 *  blind-exponential arm (no server header) — see {@link MAX_SERVER_DELAY_MS}
 *  for the separate ceiling on a server-instructed delay. */
const MAX_DELAY_MS = 15_000

/** Ceiling for a SERVER-instructed `retry-after` delay (ADR-0208). Deliberately
 *  higher than {@link MAX_DELAY_MS}: when the server explicitly says "retry in N
 *  seconds" it knows when capacity returns, so honoring a value past the blind
 *  15s exponential cap is correct (clamping a real 30s `retry-after` to 15s just
 *  guarantees a second 429). The cap is NOT an arbitrary magic delay — it is the
 *  largest delay a real provider asks for in practice and matches Claude
 *  Desktop's documented "60s when no parsable delay" reference value; it exists
 *  only to bound a hostile / buggy header (e.g. a year-ahead HTTP-date) so a
 *  single attempt can never sleep unboundedly. A header beyond this is clamped
 *  to 60s, not discarded — the server still gets a long backoff, just a sane
 *  one. */
const MAX_SERVER_DELAY_MS = 60_000

/** Resolve the wait before retry attempt `n`. When the classified error carries
 *  a server-instructed `retryAfterMs` (parsed at the `LLMError.fromSdkError`
 *  boundary from `retry-after` / `retry-after-ms` / `x-ratelimit-reset`), the
 *  SERVER'S instruction wins — clamped to {@link MAX_SERVER_DELAY_MS}. Otherwise
 *  the existing full-jitter exponential backoff is used BYTE-IDENTICALLY to the
 *  header-absent behavior (same {@link backoffDelayMs} call, same args). */
const resolveDelayMs = (
  e: unknown,
  attempt: number,
  baseDelayMs: number,
  random: () => number,
): number => {
  if (e instanceof LLMError && e.retryAfterMs !== undefined && Number.isFinite(e.retryAfterMs)) {
    return Math.min(Math.max(0, e.retryAfterMs), MAX_SERVER_DELAY_MS)
  }
  return backoffDelayMs(attempt, baseDelayMs, random)
}

/** Substrings (lowercased) marking a transient, safe-to-retry failure. */
const RETRYABLE_MARKERS = [
  "429",
  "500",
  "502",
  "503",
  "504",
  "timeout",
  "timed out",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "overloaded",
  "rate limit",
  "rate-limit",
  "ratelimit",
  "temporarily",
  "try again",
] as const

/** Substrings (lowercased) that force a NON-retryable classification even if a
 *  retryable marker also appears (auth/client errors are never transient). */
const FATAL_MARKERS = [
  "401",
  "403",
  "400",
  "404",
  "invalid api key",
  "authentication",
  "unauthorized",
  "permission",
  "malformed",
  "invalid request",
  "not found",
] as const

/** Substrings (lowercased) marking a "prompt too long" / context-overflow
 *  failure. These need reactive compaction, NOT plain retry (a retry of the
 *  same oversized prompt fails identically). */
const PTL_MARKERS = [
  "prompt is too long",
  "prompt too long",
  "context length",
  "context_length",
  "context window",
  "maximum context",
  "too many tokens",
] as const

/** True iff `e` looks like a transient LLM failure worth retrying. Only
 *  {@link LLMError} is ever retryable; unknown error types are treated fatal.
 *
 *  DOF-30 single authority: the kind-level retry verdict is DERIVED from the
 *  one `codexSpecRoute` table via {@link retryDispositionForKind} — this file
 *  no longer carries its own `RETRYABLE_KINDS`/`FATAL_KINDS` sets (removed; the
 *  table + `decorator-policy.ts` is the sole source of truth). The derivation
 *  is proven byte-identical to the removed sets for all 18 kinds
 *  (tests/unit/retry-decorator-policy-hellgate.test.ts).
 *
 *  Branches on the boundary-assigned `.kind` discriminator first: a
 *  `"retry"`/`"no_retry"` disposition decides without re-sniffing the message.
 *  A `"consult_markers"` disposition (the kinds the table has no decisive
 *  same-provider retry verdict for — `unknown` and the six Codex-spec kinds
 *  that legacy `isRetryable` also marker-scanned) falls back to the legacy
 *  message-marker scan, preserving prior behavior byte-for-byte. */
export const isRetryable = (e: unknown): boolean => {
  if (!(e instanceof LLMError)) return false
  const disposition = retryDispositionForKind(e.kind)
  if (disposition === "retry") return true
  if (disposition === "no_retry") return false
  // "consult_markers": no decisive table verdict — fall back to markers
  // (byte-identical to the pre-dedup `RETRYABLE_KINDS`/`FATAL_KINDS` miss path).
  const msg = e.message.toLowerCase()
  if (FATAL_MARKERS.some((m) => msg.includes(m))) return false
  return RETRYABLE_MARKERS.some((m) => msg.includes(m))
}

/** True iff `e`'s message indicates the prompt exceeded the model's context
 *  window. Checked BEFORE {@link isRetryable} (PTL must drive compaction, and
 *  some providers phrase it with a 400 that would otherwise read as fatal).
 *
 *  NOTE: this one stays message-based deliberately. The {@link LLMErrorKind}
 *  vocabulary has no `prompt_too_long` member — providers surface PTL as a
 *  400, which the boundary classifies as `bad_request` (indistinguishable from
 *  other client errors at the status level). The specific "context window"
 *  wording is the only available signal, so the marker scan is the correct
 *  (not legacy-fallback) mechanism here until a dedicated kind exists. */
export const isPromptTooLong = (e: unknown): boolean => {
  if (!(e instanceof LLMError)) return false
  const msg = e.message.toLowerCase()
  return PTL_MARKERS.some((m) => msg.includes(m))
}

/** How the loop should react to a thrown LLM stream error. */
export type LLMErrorKind = "prompt_too_long" | "retryable" | "fatal"

/** Single classification entry point for the in-loop recovery state machine.
 *  PTL takes precedence over retry/fatal so an oversized prompt always routes
 *  to reactive compaction instead of being retried (or wrongly declared fatal). */
export const classifyLLMError = (e: unknown): LLMErrorKind => {
  if (isPromptTooLong(e)) return "prompt_too_long"
  if (isRetryable(e)) return "retryable"
  return "fatal"
}

/** Full-jitter exponential backoff for retry attempt `n` (0-based). Exported
 *  so the in-loop turn-retry path uses byte-identical math to {@link
 *  RetryingLLM}. `random` defaults to `Math.random`; inject for tests. */
export const backoffDelayMs = (
  n: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  random: () => number = Math.random,
): number => {
  const exp = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** n)
  return Math.floor(random() * exp)
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new LLMError("aborted", { kind: "aborted" })
}

export class RetryingLLM implements LLMPort {
  /** Forward the wrapped provider's configured model id so a decorated chain
   *  (the CLI always wraps the adapter in RetryingLLM) still reports a
   *  faithful model for the pre-stream `llm_request` (RFC-0002 §5.2/§9)
   *  instead of degrading to `"unknown"`. Set conditionally (never an explicit
   *  `undefined`) to satisfy `exactOptionalPropertyTypes`, mirroring
   *  `FallbackLLM`. */
  readonly model?: string
  readonly provider?: string
  readonly surfaceId?: LlmSurfaceId
  readonly transportId?: LlmTransportId
  readonly authMode?: string
  /** aug-27 — forward the CONTEXT-WINDOW key too. This class is on EVERY CLI
   *  stack, and it never copied this field, so an adapter that pinned
   *  `<model>-1m` (the granted 1M-token beta window, ADR-0505) had it eaten here:
   *  compaction then resolved the 200k default and folded history ~4x too early.
   *  Surfaced by the decorator capability guard
   *  (`tests/unit/llm/port-identity-capability-guard.test.ts`). */
  readonly contextWindowKey?: string
  /** aug-27 — forward the wrapped port's model-catalog probe. The CLI ALWAYS
   *  wraps its adapter in this class, so a dropped `listModels` here made the
   *  `/model` picker blind to the account's real model list (it could only ever
   *  offer the boot model). Re-bound to `inner` (the adapters implement it as a
   *  `this`-reading method), and absent when the inner port has none. */
  readonly listModels?: () => Promise<readonly string[]>
  private readonly inner: LLMPort
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly signal: AbortSignal | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly errorRouting:
    | { readonly classifier: ErrorClassifier; readonly router: RetryRouter }
    | undefined

  constructor(opts: RetryingLLMOptions) {
    this.inner = opts.inner
    const innerModel = opts.inner.model
    if (innerModel !== undefined) this.model = innerModel
    const innerProvider = opts.inner.provider
    if (innerProvider !== undefined) this.provider = innerProvider
    const innerWindowKey = opts.inner.contextWindowKey
    if (innerWindowKey !== undefined) this.contextWindowKey = innerWindowKey
    const innerSurfaceId = opts.inner.surfaceId
    if (innerSurfaceId !== undefined) this.surfaceId = innerSurfaceId
    const innerTransportId = opts.inner.transportId
    if (innerTransportId !== undefined) this.transportId = innerTransportId
    const innerAuthMode = opts.inner.authMode
    if (innerAuthMode !== undefined) this.authMode = innerAuthMode
    const innerListModels = opts.inner.listModels
    if (innerListModels !== undefined) {
      this.listModels = async () => await innerListModels.call(opts.inner)
    }
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    const signal = opts.signal
    this.signal = signal
    // jun-10 silent-failure audit #6: the default backoff MUST honor the
    // abort signal (Esc/Ctrl+C mid-429-backoff previously hung up to 60s).
    // The abort-aware sleep resolves early on abort; the loop's post-sleep
    // `throwIfAborted` then surfaces the typed `aborted` LLMError.
    this.sleep =
      opts.sleep ??
      (signal !== undefined
        ? (ms) => abortAwareSleep(ms, signal)
        : (ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = opts.random ?? Math.random
    this.errorRouting = opts.errorRouting
  }

  /** Delay before retry attempt `n` (0-based). Prefers a server-instructed
   *  `retry-after` carried on the error (ADR-0208); falls back to full-jitter
   *  exponential backoff byte-identically when none is present. */
  private delayFor(e: unknown, n: number): number {
    return resolveDelayMs(e, n, this.baseDelayMs, this.random)
  }

  /** ADR-0203 wire — when `errorRouting` is set, an `abort`/`hitl` decision
   *  short-circuits the legacy retry path (rethrow immediately, no backoff).
   *  Other decisions defer to the existing `isRetryable` predicate so the
   *  default-OFF byte-identical contract holds when no router is wired. */
  private routerForbidsRetry(e: unknown): boolean {
    const r = this.errorRouting
    if (r === undefined) return false
    const action = r.router.decide(r.classifier.classify(e))
    return action === "abort" || action === "hitl"
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(this.signal)
      let yielded = false
      try {
        for await (const ev of this.inner.stream(input)) {
          yielded = true
          yield ev
        }
        return
      } catch (e) {
        // Mid-stream failure: rethrow — retrying would duplicate output.
        if (yielded) throw e
        // ADR-0203 wire — typed router can shortcut to "do not retry" even
        // when legacy markers vote retryable (e.g. a `cyberPolicy` shaped as
        // an overload message). Defense-in-depth: BOTH must vote retry.
        if (this.routerForbidsRetry(e)) throw e
        if (attempt >= this.maxRetries || !isRetryable(e)) throw e
        throwIfAborted(this.signal)
        await this.sleep(this.delayFor(e, attempt))
        throwIfAborted(this.signal)
      }
    }
  }
}

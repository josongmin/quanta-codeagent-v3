/**
 * ADR-0237 — `tooManyFailedAttempts` layer-owned arm wire (LLM error 16-kind
 * close-out, slice A of 3).
 *
 * # What this is
 *
 * A pure, default-OFF decorator factory `withFailureCounter(inner, knobs)` that
 * wraps an arbitrary {@link LLMPort} and:
 *
 *   1. Counts CONSECUTIVE pre-stream failures (no event yielded ⇒ counted).
 *   2. Resets the counter on the first successful event (one valid yield wins).
 *   3. When the count reaches `maxConsecutiveFailures`, re-throws the failure
 *      RE-WRAPPED as `LLMError("too_many_failed_attempts", ...)` with the
 *      original error preserved on `cause` so downstream consumers (the
 *      `CodexSpecRouter` 16-kind switch — already maps this kind to `fatal`)
 *      can route it without re-classifying.
 *
 * # Why this lives in `src/llm/retry/`
 *
 * `too_many_failed_attempts` is one of the THREE layer-owned arms in the
 * ADR-0214 16-kind `LLMErrorKind` taxonomy that the adapter boundary cannot
 * emit (the provider has no "you burned the retry budget" return code — only
 * the retry layer KNOWS the budget was burned). ADR-0234 wired the two
 * provider-emitable arms (`cyber_policy` / `context_window_exceeded`) at the
 * adapter; this slice closes the layer-owned counter side.
 *
 * # Default-OFF
 *
 * The factory is purely additive. Existing `RetryingLLM` / `FallbackLLM`
 * decorators do NOT invoke this — they would have to be EXPLICITLY composed
 * with `withFailureCounter` (or a future opt-in slot wired by the composition
 * root). Default knob value: `enabled: false` → identity decorator (no
 * counter, no allocation in the hot path). Caller MUST explicitly opt-in.
 *
 * # No-throw posture
 *
 * The counter NEVER throws of its own accord. It only RE-WRAPS errors the
 * inner port already threw. The counter itself is a pure number — no side
 * effects, no async, no I/O. A consumer that wants to inspect the count for
 * observability reads `getFailureCount()` after each `stream()` iteration.
 *
 * # Counter semantics (hellgate-pinned)
 *
 *   - "Failure" = the inner stream throws WITHOUT yielding any event.
 *     Mid-stream throws (≥1 event yielded) DO NOT increment the counter
 *     (mirrors the {@link RetryingLLM} contract: mid-stream rethrow is a
 *     transcript-corruption avoidance, not a budget event).
 *   - "Success" = the inner stream yields ≥1 event and completes (the
 *     for-await loop terminates normally). The counter RESETS to 0 on success.
 *   - The counter is per-decorator-instance state (caller controls lifetime).
 *     Two separate `withFailureCounter` wrappers maintain independent counts.
 *
 * # Knob shape
 *
 * `LLMRetryKnobs` is a closed `Readonly` shape so a typo at the call site
 * fails to compile (no string-keyed bag). The knob set is intentionally
 * narrow today (`enabled` + `maxConsecutiveFailures`); future arms (e.g. a
 * separate budget-window) extend this same type.
 */

import { LLMError, type LLMProvider } from "@/shared"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"

/** Default cap when `maxConsecutiveFailures` is omitted. Chosen to match the
 *  `RetryingLLM` default `maxRetries = 4` PLUS one (so the cap is hit on the
 *  attempt AFTER the legacy retry budget would have given up — useful when
 *  composed AROUND a `RetryingLLM`). Hellgate pins this default. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5

/** Closed knob set for the LLM retry / failure-counter layer. exactOptional:
 *  omitted fields must be absent (NEVER `undefined`-set). Mirrors the
 *  documented convention from `OsSandboxConfig` / `RetryingLLMOptions`. */
export interface LLMRetryKnobs {
  /** Default-OFF (`false`). When `false`, `withFailureCounter` returns the
   *  inner port verbatim (identity decorator — no counter state, no
   *  re-throw, byte-identical for every legacy caller). */
  readonly enabled?: boolean
  /** Consecutive pre-stream failure cap. Counter starts at 0; each
   *  pre-stream throw +1; reaching `maxConsecutiveFailures` RE-WRAPS the
   *  next throw as `LLMError("too_many_failed_attempts", ...)`.
   *  Default: {@link DEFAULT_MAX_CONSECUTIVE_FAILURES} (5).
   *  Min: 1 (clamped — `0` would emit on the very first failure which
   *  defeats the "retry budget" semantic; ≤0 is treated as 1). */
  readonly maxConsecutiveFailures?: number
}

/** Internal: counter handle returned by {@link withFailureCounter}. Callers
 *  that want observability into the counter (e.g. an OTel attribute on the
 *  next span) read `getFailureCount()` after each stream iteration. The hot
 *  path never allocates anything else. */
export interface FailureCounterHandle {
  /** Current consecutive failure count. Reset to 0 after a successful
   *  iteration. */
  getFailureCount(): number
  /** Reset the counter to 0. Hosts call this on a turn boundary if they
   *  want the budget to be PER-TURN rather than PER-INSTANCE (default
   *  is per-instance). */
  reset(): void
}

/** Construct an identity decorator (knob OFF / no-op). Pure — returns the
 *  inner port verbatim. Exported so callers MAY opt into a counter handle
 *  WITHOUT changing their port wiring (the handle just always reads 0). */
const identityHandle: FailureCounterHandle = {
  getFailureCount: () => 0,
  reset: () => {
    // identity: no state.
  },
}

/**
 * Decorate an inner `LLMPort` with a consecutive-pre-stream-failure counter.
 *
 * Returns BOTH the decorated port and a small handle so callers can observe
 * the count (for OTel / telemetry / debug). The handle is opt-in — a caller
 * that does not destructure it pays nothing.
 *
 * When `knobs.enabled !== true`, this function returns `{ port: inner,
 * handle: identityHandle }` — no allocation beyond the small wrapper object.
 *
 * @example
 *   const { port: counted, handle } = withFailureCounter(retrying, {
 *     enabled: true, maxConsecutiveFailures: 5
 *   })
 *   // ... use `counted` exactly as you would `retrying`.
 *   // After each turn:
 *   metrics.gauge("llm.consecutive_failures", handle.getFailureCount())
 */
export const withFailureCounter = (
  inner: LLMPort,
  knobs: LLMRetryKnobs | undefined,
): { readonly port: LLMPort; readonly handle: FailureCounterHandle } => {
  if (knobs?.enabled !== true) {
    return { port: inner, handle: identityHandle }
  }
  const cap = clampCap(knobs.maxConsecutiveFailures)
  let count = 0
  const port: LLMPort = {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      let yielded = false
      try {
        for await (const ev of inner.stream(input)) {
          yielded = true
          yield ev
        }
        // Successful completion ⇒ reset the consecutive failure counter.
        count = 0
        return
      } catch (e) {
        // Mid-stream throws do NOT participate in the budget — only PRE-STREAM
        // failures count. Mid-stream is a transcript-corruption rethrow, not
        // a "request failed" event.
        if (yielded) throw e
        // Pre-stream throw: tick + possibly re-wrap.
        count += 1
        if (count >= cap) {
          throw wrapAsTooMany(e, count, cap)
        }
        throw e
      }
    },
  }
  const handle: FailureCounterHandle = {
    getFailureCount: () => count,
    reset: () => {
      count = 0
    },
  }
  return { port, handle }
}

/** Clamp the cap to ≥1. `undefined` / `≤0` / `NaN` / `Infinity` → DEFAULT. */
const clampCap = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_MAX_CONSECUTIVE_FAILURES
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CONSECUTIVE_FAILURES
  const n = Math.floor(raw)
  if (n < 1) return 1
  return n
}

/** Re-wrap a thrown error as `LLMError("too_many_failed_attempts", ...)`,
 *  preserving the original via `cause` and forwarding `provider` /
 *  `statusCode` / `providerCode` when the cause is already an `LLMError`
 *  so downstream observability (which reads these fields) sees the same
 *  shape it would on the underlying failure. */
const wrapAsTooMany = (cause: unknown, count: number, cap: number): LLMError => {
  const provider: LLMProvider | undefined = cause instanceof LLMError ? cause.provider : undefined
  const statusCode: number | undefined = cause instanceof LLMError ? cause.statusCode : undefined
  const providerCode: string | undefined =
    cause instanceof LLMError ? cause.providerCode : undefined
  const innerMsg = cause instanceof Error ? cause.message : String(cause)
  return new LLMError(`too many consecutive LLM failures (${count}/${cap}): ${innerMsg}`, {
    cause,
    kind: "too_many_failed_attempts",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(provider !== undefined ? { provider } : {}),
  })
}

/** Test-only re-exports. Internal helpers exposed so the hellgate can pin
 *  their semantics (clamp behavior, wrap shape) without re-implementing. */
export const __test = {
  clampCap,
  wrapAsTooMany,
  identityHandle,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
}

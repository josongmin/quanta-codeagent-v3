import { LLMError } from "@/shared"
import type { LlmSurfaceId, LlmTransportId } from "@/shared/llm-route-types"
import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

/**
 * Structural metrics-sink shape used for fallback observability. We avoid
 * importing `@/observability` here — that would violate the `@/llm` slice
 * rule (biome `noRestrictedImports`). Instead a CALLER (`@/runner`) that
 * already owns a `MetricsRegistry` passes it as-is; structural typing makes
 * the real `MetricsRegistry.increment(name, delta?, labels?)` satisfy this
 * shape without coupling.
 *
 * Default-OFF: when `metrics` is undefined the recorder is the noop sentinel
 * (`NOOP_FALLBACK_METRICS`) and no emit happens — byte-identical to the
 * pre-instrumentation behavior. */
export interface FallbackMetricSink {
  increment(name: string, delta?: number, labels?: Record<string, string>): void
}

/** Sentinel noop sink — used when no `metrics` was passed. A real sink may be
 *  injected by `composeLLMCore` (runner) — see `src/runner/assemble/llm.ts`. */
const NOOP_FALLBACK_METRICS: FallbackMetricSink = { increment: () => {} }

/** Metric names emitted by FallbackLLM. Pin them as constants so test
 *  assertions and dashboard queries reference a SINGLE source of truth. */
export const FALLBACK_METRIC_NAMES = Object.freeze({
  attempt: "llm.fallback.attempt.total",
  triggered: "llm.fallback.triggered.total",
  exhausted: "llm.fallback.exhausted.total",
} as const)

/**
 * `LLMPort` decorator implementing same-turn provider fallback. Wraps an
 * ordered list `[primary, ...fallbacks]`; streams from the head provider and,
 * on a *fallback-triggering* failure, advances to the next provider and retries
 * the SAME turn on it. Mirrors Claude Code v2's `FallbackTriggeredError` path
 * (3×overload(529)/"overloaded" on a primary → swap model, tombstone the
 * already-streamed partial, retry the turn on the fallback model). See
 * docs/analysis/agent-loop-error-predicates.md §3.
 *
 * Stream-integrity contract (the {@link RetryingLLM} invariant, generalised):
 * - If NO event has been yielded yet when a provider fails, switching is
 *   completely transparent — the next provider's stream is yielded as if it
 *   were the original (no `stream_reset`).
 * - If events WERE already yielded, we cannot silently continue (a downstream
 *   assembler has half a dead message). Instead the FIRST event from the
 *   replacement provider is a `{ type: "stream_reset" }` tombstone, so the
 *   consumer ({@link assembleFromEvents}) discards the dead partial and keeps
 *   only the fallback's output. The tombstone is emitted **once per switch
 *   that follows a partial** (NOT once per turn): if three providers each
 *   stream a partial then fail before a fourth succeeds, the consumer sees
 *   THREE tombstones. This is required for correctness — a single global
 *   tombstone would reset only the first dead partial and let the second and
 *   third providers' dead partials leak into the assembled message. Each
 *   tombstone is lazy: emitted only when a real fallback event actually
 *   follows (an accepted-but-empty replacement still tombstones the prior
 *   partial via the post-loop guard below).
 * - Exhausting every provider rethrows the LAST error.
 * - A non-fallback error (auth/400/malformed/etc.) is rethrown IMMEDIATELY
 *   without trying any further provider.
 * - The optional AbortSignal is honored before each provider attempt and
 *   surfaces as an aborting `LLMError` (consistent with `RetryingLLM`).
 *
 * Deterministic-testable: providers are injected as plain `LLMPort`s (mock
 * async-generators); no timers, no randomness, nothing else to inject.
 */
export interface FallbackLLMOptions {
  /** Ordered providers: index 0 is the primary, the rest are fallbacks tried
   *  left-to-right. Must be non-empty. */
  providers: readonly LLMPort[]
  signal?: AbortSignal
  /** Override the fallback-trigger classifier (testing / policy tuning).
   *  Defaults to {@link isFallbackTrigger}. */
  isFallbackTrigger?: (e: unknown) => boolean
  /** Optional metrics sink — structurally compatible with `MetricsRegistry`.
   *  When omitted, no metric is emitted (Default-OFF). Names emitted:
   *    - `llm.fallback.attempt.total`    labels: model, index
   *    - `llm.fallback.triggered.total`  labels: kind, from, to, post_yield
   *    - `llm.fallback.exhausted.total`  labels: last_kind
   *  See {@link FALLBACK_METRIC_NAMES}. */
  metrics?: FallbackMetricSink
}

/** Kinds that warrant switching to the next provider. STRUCTURED — no regex
 *  on `e.message`. Adapters set `LLMError.kind` at the boundary
 *  ({@link LLMError.fromSdkError}); this set is the policy.
 *
 *  - `overloaded`       529-class: this provider is over capacity → try next.
 *  - `server_error`     Non-529 5xx: provider-side bug → try next.
 *  - `network`          Transport failure (ECONNRESET / EPIPE / DNS): peer
 *                       reachability is the issue → another provider may work.
 *  - `not_implemented`  Stub adapter (e.g. ADR-0094 Phase-1 `chatgpt-oauth`):
 *                       this provider physically cannot serve the turn, but a
 *                       fully-wired sibling provider can.
 *
 *  Explicitly NOT triggers (every provider would fail identically):
 *  `auth`, `bad_request`, `not_found`, `stream_corrupt`, `aborted`,
 *  `rate_limit` (latter is same-turn retried, not fallback'd), `unknown`. */
const FALLBACK_KINDS = new Set<import("@/shared").LLMErrorKind>([
  "overloaded",
  "server_error",
  "network",
  "not_implemented",
])

/** True iff `e` is a provider-overload / provider-side failure that warrants
 *  switching providers. Only {@link LLMError} is ever a trigger; unknown
 *  error types are treated as non-fallback (rethrown immediately). */
export const isFallbackTrigger = (e: unknown): boolean => {
  if (!(e instanceof LLMError)) return false
  return FALLBACK_KINDS.has(e.kind)
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return
  // Capture the structured reason if the AbortController carried one — caller
  // can distinguish user-cancel, deadline, upstream-shutdown.
  const reason = signal.reason
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : reason === undefined
          ? "abort signal fired"
          : "abort signal fired with non-string reason"
  throw new LLMError(`aborted: ${detail}`, {
    kind: "aborted",
    ...(reason instanceof Error ? { cause: reason } : {}),
  })
}

export class FallbackLLM implements LLMPort {
  private readonly providers: readonly LLMPort[]
  private readonly signal: AbortSignal | undefined
  private readonly isFallbackTrigger: (e: unknown) => boolean
  private readonly metrics: FallbackMetricSink
  /** The chain reports the PRIMARY (index 0) provider's model — the one it
   *  streams from first — so a fallback chain still emits a faithful
   *  pre-stream `llm_request`. Absent if the primary omits `model`. */
  readonly model?: string
  readonly provider?: string
  readonly surfaceId?: LlmSurfaceId
  readonly transportId?: LlmTransportId
  readonly authMode?: string

  constructor(opts: FallbackLLMOptions) {
    if (opts.providers.length === 0) {
      throw new LLMError("FallbackLLM requires at least one provider", { kind: "bad_request" })
    }
    this.providers = opts.providers
    // Mirror the primary's model only when it exposes one (exactOptional:
    // an absent model stays absent rather than an explicit `undefined`).
    const primaryModel = opts.providers[0]?.model
    if (primaryModel !== undefined) this.model = primaryModel
    const primaryProvider = opts.providers[0]?.provider
    if (primaryProvider !== undefined) this.provider = primaryProvider
    const primarySurfaceId = opts.providers[0]?.surfaceId
    if (primarySurfaceId !== undefined) this.surfaceId = primarySurfaceId
    const primaryTransportId = opts.providers[0]?.transportId
    if (primaryTransportId !== undefined) this.transportId = primaryTransportId
    const primaryAuthMode = opts.providers[0]?.authMode
    if (primaryAuthMode !== undefined) this.authMode = primaryAuthMode
    this.signal = opts.signal
    this.isFallbackTrigger = opts.isFallbackTrigger ?? isFallbackTrigger
    this.metrics = opts.metrics ?? NOOP_FALLBACK_METRICS
  }

  /** Emit a metric without ever throwing — observability cannot break the
   *  wrapped stream. Mirror of the pattern in `instrument-tool.ts`. */
  private emit(name: string, labels: Record<string, string>): void {
    try {
      this.metrics.increment(name, 1, labels)
    } catch {
      /* metric-sink failure must not block the stream */
    }
  }

  /** Extract `kind` label from an LLMError-shaped throw; `unknown` otherwise.
   *  Structural — works with the production `LLMError` and any test double
   *  with a string `kind` property. */
  private kindOf(e: unknown): string {
    if (e instanceof LLMError) return e.kind
    if (typeof e === "object" && e !== null && "kind" in e) {
      const k = (e as { kind: unknown }).kind
      if (typeof k === "string") return k
    }
    return "unknown"
  }

  /**
   * Stream from one provider. If `priorPartial` is set, the first real event
   * is preceded by a single `{ type: "stream_reset" }` tombstone (lazy: only
   * when output actually follows, exactly once). `yielded.value` is set true
   * once this provider has emitted ≥1 of its OWN events, so a caller can
   * decide whether a subsequent failure must tombstone this partial.
   */
  private async *streamProvider(
    provider: LLMPort,
    input: StreamInput,
    priorPartial: boolean,
    yielded: { value: boolean },
  ): AsyncIterable<StreamEvent> {
    let resetEmitted = false
    for await (const ev of provider.stream(input)) {
      if (priorPartial && !resetEmitted) {
        resetEmitted = true
        yield { type: "stream_reset" }
      }
      yielded.value = true
      yield ev
    }
    // R-Phase5 P1-G: if the replacement provider yielded ZERO events (an
    // edge case — accepted-but-empty response, or all events filtered) AND
    // a prior partial exists, we still need to tombstone the dead partial.
    // Otherwise the assembler keeps the prior provider's half-streamed
    // content as the final message. Pre-fix the `for await` never ran, so
    // `resetEmitted` stayed false and the tombstone was dropped silently.
    if (priorPartial && !resetEmitted) {
      yield { type: "stream_reset" }
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // True once a PRIOR provider yielded ≥1 event before failing this turn.
    // When true, the next provider's output is preceded by a `stream_reset`
    // tombstone (the prior partial is dead). A switch where this is still
    // false is fully transparent.
    let priorPartial = false

    let lastErrorKind = "unknown"
    for (let i = 0; i < this.providers.length; i++) {
      throwIfAborted(this.signal)
      const provider = this.providers[i]
      if (!provider) continue
      const isLast = i === this.providers.length - 1
      // Per-attempt counter — labelled with model id (when known) + slot
      // index. The primary is index=0; a swap is observable as an
      // attempt with index > 0.
      this.emit(FALLBACK_METRIC_NAMES.attempt, {
        model: provider.model ?? "unknown",
        index: String(i),
      })
      // Did THIS provider yield ≥1 event?
      const yielded = { value: false }
      try {
        yield* this.streamProvider(provider, input, priorPartial, yielded)
        return
      } catch (e) {
        if (isLast || !this.isFallbackTrigger(e)) {
          if (isLast) {
            // All providers exhausted (final one threw) — emit a terminal
            // counter so dashboards can alert on "fallback chain failed
            // entirely". `last_kind` is the kind of the FINAL provider's
            // error (the one being rethrown), structurally extracted.
            lastErrorKind = this.kindOf(e)
            this.emit(FALLBACK_METRIC_NAMES.exhausted, { last_kind: lastErrorKind })
          }
          throw e
        }
        // Fallback IS being taken — emit the swap counter. `from` is the
        // dying provider, `to` is the next slot. `post_yield` distinguishes
        // a transparent pre-yield swap (false) from a tombstone-bearing
        // mid-stream swap (true) — the latter is more disruptive.
        const next = this.providers[i + 1]
        this.emit(FALLBACK_METRIC_NAMES.triggered, {
          kind: this.kindOf(e),
          from: provider.model ?? "unknown",
          to: next?.model ?? "unknown",
          post_yield: yielded.value ? "true" : "false",
        })
        // If this provider streamed anything before failing, the next
        // provider must tombstone it. (Pre-yield failures stay transparent.)
        if (yielded.value) priorPartial = true
        throwIfAborted(this.signal)
      }
    }

    // Unreachable: the loop either returns on success or rethrows on the last
    // provider. Defensive throw keeps the type checker honest.
    throw new LLMError("FallbackLLM exhausted all providers", { kind: "unknown" })
  }
}

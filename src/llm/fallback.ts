import { LLMError } from "@/shared"
import type { LLMPort } from "./ports"
import type { StreamEvent, StreamInput } from "./types"

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
 *   only the fallback's output. The tombstone is emitted at most once per
 *   switch and only when a real fallback event follows.
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
}

/** Kinds that warrant switching to the next provider. STRUCTURED — no regex
 *  on `e.message`. Adapters set `LLMError.kind` at the boundary
 *  ({@link LLMError.fromSdkError}); this set is the policy.
 *
 *  - `overloaded`     529-class: this provider is over capacity → try next.
 *  - `server_error`   Non-529 5xx: provider-side bug → try next.
 *  - `network`        Transport failure (ECONNRESET / EPIPE / DNS): peer
 *                     reachability is the issue → another provider may work.
 *
 *  Explicitly NOT triggers (every provider would fail identically):
 *  `auth`, `bad_request`, `not_found`, `stream_corrupt`, `aborted`,
 *  `rate_limit` (latter is same-turn retried, not fallback'd), `unknown`. */
const FALLBACK_KINDS = new Set<import("@/shared").LLMErrorKind>([
  "overloaded",
  "server_error",
  "network",
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
  /** The chain reports the PRIMARY (index 0) provider's model — the one it
   *  streams from first — so a fallback chain still emits a faithful
   *  pre-stream `llm_request`. Absent if the primary omits `model`. */
  readonly model?: string

  constructor(opts: FallbackLLMOptions) {
    if (opts.providers.length === 0) {
      throw new LLMError("FallbackLLM requires at least one provider", { kind: "bad_request" })
    }
    this.providers = opts.providers
    // Mirror the primary's model only when it exposes one (exactOptional:
    // an absent model stays absent rather than an explicit `undefined`).
    const primaryModel = opts.providers[0]?.model
    if (primaryModel !== undefined) this.model = primaryModel
    this.signal = opts.signal
    this.isFallbackTrigger = opts.isFallbackTrigger ?? isFallbackTrigger
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

    for (let i = 0; i < this.providers.length; i++) {
      throwIfAborted(this.signal)
      const provider = this.providers[i]
      if (!provider) continue
      const isLast = i === this.providers.length - 1
      // Did THIS provider yield ≥1 event?
      const yielded = { value: false }
      try {
        yield* this.streamProvider(provider, input, priorPartial, yielded)
        return
      } catch (e) {
        if (isLast || !this.isFallbackTrigger(e)) throw e
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

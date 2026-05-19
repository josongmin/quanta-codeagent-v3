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

/** Substrings (lowercased) marking a provider-overload / unrecoverable-provider
 *  failure that should move to the next provider rather than be retried in
 *  place. Derived from the v2 `zDH` predicate (`status === 529` or message
 *  contains `"overloaded_error"`) plus the documented "Repeated 529 Overloaded
 *  errors" terminal and explicit provider-unavailable phrasings. */
const FALLBACK_MARKERS = [
  "529",
  "overloaded",
  "overloaded_error",
  "repeated 529",
  "provider unavailable",
  "service unavailable",
  "no healthy upstream",
  "upstream connect error",
] as const

/** Substrings (lowercased) that are client/auth/shape errors: never a reason to
 *  try another provider (every provider would fail identically). Mirrors
 *  `RetryingLLM`'s FATAL_MARKERS so classification stays consistent. */
const NON_FALLBACK_MARKERS = [
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

/** True iff `e` is a provider-overload / unrecoverable-provider failure that
 *  warrants switching providers. Only {@link LLMError} is ever a trigger;
 *  unknown error types are treated as non-fallback (rethrown immediately).
 *  An explicit client/auth marker forces a non-fallback classification even if
 *  an overload marker also appears. */
export const isFallbackTrigger = (e: unknown): boolean => {
  if (!(e instanceof LLMError)) return false
  const status = (e as { status?: unknown }).status
  if (status === 529) return true
  const msg = e.message.toLowerCase()
  if (NON_FALLBACK_MARKERS.some((m) => msg.includes(m))) return false
  return FALLBACK_MARKERS.some((m) => msg.includes(m))
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new LLMError("aborted")
}

export class FallbackLLM implements LLMPort {
  private readonly providers: readonly LLMPort[]
  private readonly signal: AbortSignal | undefined
  private readonly isFallbackTrigger: (e: unknown) => boolean

  constructor(opts: FallbackLLMOptions) {
    if (opts.providers.length === 0) {
      throw new LLMError("FallbackLLM requires at least one provider")
    }
    this.providers = opts.providers
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
    throw new LLMError("FallbackLLM exhausted all providers")
  }
}

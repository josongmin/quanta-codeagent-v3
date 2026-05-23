import { LLMError } from "@/shared";
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
const FALLBACK_KINDS = new Set([
    "overloaded",
    "server_error",
    "network",
    "not_implemented",
]);
/** True iff `e` is a provider-overload / provider-side failure that warrants
 *  switching providers. Only {@link LLMError} is ever a trigger; unknown
 *  error types are treated as non-fallback (rethrown immediately). */
export const isFallbackTrigger = (e) => {
    if (!(e instanceof LLMError))
        return false;
    return FALLBACK_KINDS.has(e.kind);
};
const throwIfAborted = (signal) => {
    if (!signal?.aborted)
        return;
    // Capture the structured reason if the AbortController carried one — caller
    // can distinguish user-cancel, deadline, upstream-shutdown.
    const reason = signal.reason;
    const detail = reason instanceof Error
        ? reason.message
        : typeof reason === "string"
            ? reason
            : reason === undefined
                ? "abort signal fired"
                : "abort signal fired with non-string reason";
    throw new LLMError(`aborted: ${detail}`, {
        kind: "aborted",
        ...(reason instanceof Error ? { cause: reason } : {}),
    });
};
export class FallbackLLM {
    providers;
    signal;
    isFallbackTrigger;
    /** The chain reports the PRIMARY (index 0) provider's model — the one it
     *  streams from first — so a fallback chain still emits a faithful
     *  pre-stream `llm_request`. Absent if the primary omits `model`. */
    model;
    constructor(opts) {
        if (opts.providers.length === 0) {
            throw new LLMError("FallbackLLM requires at least one provider", { kind: "bad_request" });
        }
        this.providers = opts.providers;
        // Mirror the primary's model only when it exposes one (exactOptional:
        // an absent model stays absent rather than an explicit `undefined`).
        const primaryModel = opts.providers[0]?.model;
        if (primaryModel !== undefined)
            this.model = primaryModel;
        this.signal = opts.signal;
        this.isFallbackTrigger = opts.isFallbackTrigger ?? isFallbackTrigger;
    }
    /**
     * Stream from one provider. If `priorPartial` is set, the first real event
     * is preceded by a single `{ type: "stream_reset" }` tombstone (lazy: only
     * when output actually follows, exactly once). `yielded.value` is set true
     * once this provider has emitted ≥1 of its OWN events, so a caller can
     * decide whether a subsequent failure must tombstone this partial.
     */
    async *streamProvider(provider, input, priorPartial, yielded) {
        let resetEmitted = false;
        for await (const ev of provider.stream(input)) {
            if (priorPartial && !resetEmitted) {
                resetEmitted = true;
                yield { type: "stream_reset" };
            }
            yielded.value = true;
            yield ev;
        }
        // R-Phase5 P1-G: if the replacement provider yielded ZERO events (an
        // edge case — accepted-but-empty response, or all events filtered) AND
        // a prior partial exists, we still need to tombstone the dead partial.
        // Otherwise the assembler keeps the prior provider's half-streamed
        // content as the final message. Pre-fix the `for await` never ran, so
        // `resetEmitted` stayed false and the tombstone was dropped silently.
        if (priorPartial && !resetEmitted) {
            yield { type: "stream_reset" };
        }
    }
    async *stream(input) {
        // True once a PRIOR provider yielded ≥1 event before failing this turn.
        // When true, the next provider's output is preceded by a `stream_reset`
        // tombstone (the prior partial is dead). A switch where this is still
        // false is fully transparent.
        let priorPartial = false;
        for (let i = 0; i < this.providers.length; i++) {
            throwIfAborted(this.signal);
            const provider = this.providers[i];
            if (!provider)
                continue;
            const isLast = i === this.providers.length - 1;
            // Did THIS provider yield ≥1 event?
            const yielded = { value: false };
            try {
                yield* this.streamProvider(provider, input, priorPartial, yielded);
                return;
            }
            catch (e) {
                if (isLast || !this.isFallbackTrigger(e))
                    throw e;
                // If this provider streamed anything before failing, the next
                // provider must tombstone it. (Pre-yield failures stay transparent.)
                if (yielded.value)
                    priorPartial = true;
                throwIfAborted(this.signal);
            }
        }
        // Unreachable: the loop either returns on success or rethrows on the last
        // provider. Defensive throw keeps the type checker honest.
        throw new LLMError("FallbackLLM exhausted all providers", { kind: "unknown" });
    }
}

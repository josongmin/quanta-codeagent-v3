/**
 * Compaction circuit breaker (RFC §8 Phase 2 hardening).
 *
 * Mirrors Claude Code v2's two anti-thrash guards (see
 * `docs/analysis/compaction-system.md` §1.8 and §1.2 / §1.4):
 *
 *  - **rapid-refill breaker** (`rapidRefillCounter` / `rapidRefillCap`, CC
 *    `Qy8` ≥ `oY6=3`): when the context refills to the limit and we have to
 *    *reactively* compact again and again with no real headroom gained, CC
 *    aborts the turn with the `rapid_refill_breaker` reason rather than spin
 *    forever on an un-shrinkable prompt.
 *  - **circuit breaker** (CC `consecutiveFailures >= z_K=3`,
 *    `tengu_auto_compact_circuit_breaker`): proactive compaction that keeps
 *    running without freeing tokens is disabled for the rest of the session.
 *
 * This class is a *pure, deterministic* state machine: it never touches the
 * transcript, the LLM, or the clock. The agent loop feeds it the
 * before/after token estimates around every compaction and a `noteProgress()`
 * signal on any turn that made real headway; it asks {@link check} before the
 * next compaction-driven retry and surfaces the returned reason verbatim.
 *
 * "No progress" == post-compaction token count did not drop by at least
 * `minProgressRatio` relative to the pre-compaction count. A compaction that
 * shrinks the prompt by < ~15% is, in practice, thrashing (CC's heuristic:
 * the limiting payload — a giant file read or tool output — is still in the
 * retained suffix, so summarizing the prefix barely moved the needle).
 */
export const DEFAULT_COMPACTION_BREAKER_CAPS = {
    maxConsecutiveReactive: 3,
    maxNoProgressProactive: 3,
    minProgressRatio: 0.15,
};
/**
 * Was this compaction productive? `before`/`after` are token estimates of the
 * whole transcript around the compaction. A non-positive `before` (nothing to
 * compact) counts as progress so a degenerate call never trips the breaker.
 */
const droppedEnough = (before, after, minRatio) => {
    if (before <= 0)
        return true;
    return (before - after) / before >= minRatio;
};
export class CompactionBreaker {
    caps;
    /** Consecutive reactive compactions that failed to free meaningful space. */
    reactiveStrikes = 0;
    /** Consecutive proactive compactions that failed to free meaningful space. */
    proactiveStrikes = 0;
    constructor(caps = {}) {
        this.caps = { ...DEFAULT_COMPACTION_BREAKER_CAPS, ...caps };
    }
    /**
     * Record the outcome of a *reactive* compaction (the post-PTL hard squeeze).
     * Productive runs reset the reactive counter; unproductive ones accumulate
     * toward {@link CompactionBreakerCaps.maxConsecutiveReactive}.
     */
    recordReactive(beforeTokens, afterTokens) {
        if (droppedEnough(beforeTokens, afterTokens, this.caps.minProgressRatio)) {
            this.reactiveStrikes = 0;
        }
        else {
            this.reactiveStrikes++;
        }
    }
    /**
     * Record the outcome of a *proactive* compaction (the over-threshold
     * autocompact). Productive runs reset the proactive counter; unproductive
     * ones accumulate toward
     * {@link CompactionBreakerCaps.maxNoProgressProactive}.
     */
    recordProactive(beforeTokens, afterTokens) {
        if (droppedEnough(beforeTokens, afterTokens, this.caps.minProgressRatio)) {
            this.proactiveStrikes = 0;
        }
        else {
            this.proactiveStrikes++;
        }
    }
    /**
     * Signal a productive turn (the model did real work / made headway). Resets
     * both counters: thrash detection is about *consecutive* failed compactions,
     * so any genuine progress in between clears the slate (CC resets the rapid
     * counter once a post-compact turn survives `turnCounter` turns).
     */
    noteProgress() {
        this.reactiveStrikes = 0;
        this.proactiveStrikes = 0;
    }
    /**
     * Ask whether the loop should bail out *before* attempting another
     * compaction-driven retry. Returns the CC-aligned abort reason verbatim
     * when a cap is hit; `{ abort:false }` otherwise.
     */
    check() {
        if (this.reactiveStrikes >= this.caps.maxConsecutiveReactive) {
            return {
                abort: true,
                reason: `rapid_refill_breaker: reactive compaction freed no meaningful ` +
                    `context ${this.reactiveStrikes} times in a row (CC ` +
                    `rapidRefillCounter ≥ ${this.caps.maxConsecutiveReactive}). A file ` +
                    `read or tool output is likely too large for the context window — ` +
                    `read in smaller chunks or start a fresh session.`,
            };
        }
        if (this.proactiveStrikes >= this.caps.maxNoProgressProactive) {
            return {
                abort: true,
                reason: `rapid_refill_breaker: proactive compaction made no progress ` +
                    `${this.proactiveStrikes} times in a row (CC consecutiveFailures ≥ ` +
                    `${this.caps.maxNoProgressProactive}, tengu_auto_compact_circuit_` +
                    `breaker). Auto-compaction is disabled — the limiting payload stays ` +
                    `in the retained suffix.`,
            };
        }
        return { abort: false };
    }
    /** Current strike counters — for telemetry / assertions only. */
    get strikes() {
        return { reactive: this.reactiveStrikes, proactive: this.proactiveStrikes };
    }
}

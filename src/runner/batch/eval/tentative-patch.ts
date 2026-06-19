/**
 * P0 — tentative-patch retention (Sonar Foundation Agent absorption, 2026-06-20).
 *
 * Measured failure mode: the agent edits the source, runs a test that PASSES (the
 * tree at that moment IS the fix), then keeps going to "validate" — re-running,
 * exploring — and either regresses the source or burns its turn budget. The run
 * ends `max_turns_exhausted` / aborted and the FINAL tree emitted is empty or a
 * later regression, throwing away the verified-green intermediate. Observed on
 * django-13417, matplotlib-22719, and across the ceiling runs.
 *
 * Sonar's fix (tech report §2.3): *"the agent is encouraged to save tentative
 * patches… Otherwise, the agent would often run out of reasoning steps while
 * trying to validate a tentative patch, thus forced to terminate without giving
 * an answer."* We do it at the HARNESS layer (not a prompt): snapshot the source
 * diff whenever the agent's own verification passes, and on a bad ending emit the
 * last verified-green snapshot instead of the empty/regressed final tree.
 *
 * This module is the PURE core: record candidates, select what to emit. No I/O,
 * no heuristics, deterministic — the snapshot trigger + git diff live in the
 * driver, the verify-pass classification is reused from `verify-guard`.
 */

/** One intermediate patch the agent's tree produced during the run. */
export interface TentativeCandidate {
  /** Source-only unified diff (already through `sourceOnlyDiff`). */
  readonly diff: string
  /** True iff the agent ran a verification that PASSED at this tree state. */
  readonly verified: boolean
  /** Monotonic order (event seq) — later wins ties. */
  readonly seq: number
}

export interface TentativeRecorder {
  /** Record a candidate observed mid-run. Empty diffs are ignored (an empty
   *  snapshot is never a better answer than what we already have). */
  record(diff: string, verified: boolean, seq: number): void
  /**
   * Select the patch to EMIT as the prediction. PURE.
   *
   * Policy (audited to avoid the "smallest picks an incomplete fix" trap — we
   * select by the agent's OWN verification, never by size):
   *   1. clean finish (`finalOk`) AND non-empty final → the final, untouched.
   *      Never second-guess a normally-completed run ⇒ byte-identical to today.
   *   2. else → the LAST verified-green candidate, if any (the latest tree the
   *      agent itself proved working — most complete, not earliest/smallest).
   *   3. else, if the final is non-empty → keep it (do NOT replace a real final
   *      with an UNVERIFIED earlier snapshot, which could be worse).
   *   4. else (final empty) → the last non-empty candidate, if any.
   *   5. else → the final ("").
   */
  selectEmitted(finalPatch: string, finalOk: boolean): string
  /** Number of candidates recorded (telemetry / wiring-proof). */
  readonly count: number
}

export const createTentativeRecorder = (): TentativeRecorder => {
  const candidates: TentativeCandidate[] = []
  return {
    record(diff, verified, seq) {
      if (diff.trim() === "") return
      candidates.push({ diff, verified, seq })
    },
    selectEmitted(finalPatch, finalOk) {
      const finalNonEmpty = finalPatch.trim() !== ""
      // 1. clean finish wins outright — byte-identical to the pre-feature path.
      if (finalOk && finalNonEmpty) return finalPatch
      // 2. last verified-green intermediate (the agent's own proven state).
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i]
        if (c?.verified) return c.diff
      }
      // 3. no verified candidate: a non-empty final stands (don't downgrade to an
      //    unverified snapshot).
      if (finalNonEmpty) return finalPatch
      // 4. final is empty: fall back to the last non-empty snapshot we saw.
      const last = candidates[candidates.length - 1]
      if (last) return last.diff
      // 5. nothing recorded and empty final.
      return finalPatch
    },
    get count() {
      return candidates.length
    },
  }
}

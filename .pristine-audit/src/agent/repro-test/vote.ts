/**
 * Repro-test RESOLVED vote (validation-time majority).
 *
 * Agentless §3.3.1 closes the loop with the SAME repro set on both sides: a set
 * of candidate pytest scripts reproduces the bug on the un-patched repo, and a
 * candidate fix is correct IFF those scripts now resolve on the PATCHED tree.
 * Selection (`select.ts`) already majority-votes which script REPRODUCES; this
 * module is the symmetric vote on the RESOLVED side, run at validation time over
 * the reproducing set.
 *
 * Why a vote (not the single selected script): the measured failure mode is a
 * false-NEGATIVE oracle — ONE brittle reproducer stays red/inconclusive even
 * after a CORRECT patch, so a single-script gate rejects the right fix and the
 * repair loop churns
 * (measured: 46→131 turns re-deriving the same patch). Re-running the whole
 * reproducing set and majority-voting denoises that single brittle script:
 * independently-phrased scripts rarely share the same brittleness, so the
 * majority flips to `resolved` when the fix is real.
 *
 * Counting (decisive vs inconclusive):
 *   - `resolved`   — sidecar reports collected tests passed.
 *   - `reproduced` — sidecar reports assertion/pytest.fail red.
 *   - everything else (`other` / `exec_failed` / `unknown`) is INCONCLUSIVE —
 *     a post-fix crash or a no-op script is NOT evidence either way and must
 *     not be counted as a "still reproduced" vote (that would re-introduce the
 *     false-NEGATIVE we are removing).
 *
 * Verdict: strict majority of the DECISIVE votes. A tie (incl. 0 decisive /
 * empty input) is `inconclusive`; strict callers must fail closed rather than
 * guess. Pure, deterministic, no I/O — fully unit-testable.
 */

import type { ReproTestSample } from "./types"

export type ReproResolvedVerdict = "resolved" | "reproduced" | "inconclusive"

export interface ReproVote {
  /** Strict-majority verdict over the decisive votes; tie ⇒ `inconclusive`. */
  verdict: ReproResolvedVerdict
  /** Count of samples that resolved on the patched tree. */
  resolved: number
  /** Count of samples that still reproduce on the patched tree. */
  reproduced: number
  /** Count of non-decisive samples (other / exec_failed / unknown). */
  inconclusive: number
}

/** Majority-vote the RESOLVED side of a re-executed reproducing set. */
export const voteResolved = (samples: readonly ReproTestSample[]): ReproVote => {
  let resolved = 0
  let reproduced = 0
  let inconclusive = 0
  for (const s of samples) {
    if (s.outcome === "resolved") resolved += 1
    else if (s.outcome === "reproduced") reproduced += 1
    else inconclusive += 1
  }
  const verdict: ReproResolvedVerdict =
    resolved > reproduced ? "resolved" : reproduced > resolved ? "reproduced" : "inconclusive"
  return { verdict, resolved, reproduced, inconclusive }
}

/**
 * TC — map a re-executed reproducing set to the VerificationBundle's
 * `patchedResolvedKofN` HARD signal: `votes` = how many scripts resolved on the
 * PATCHED tree, against a caller-chosen quorum `k`.
 *
 * This is the strongest "the patch actually fixed it" signal — symmetric to the
 * base-side reproduced vote ({@link voteResolved} counts the same outcomes; this
 * just projects the resolved count into the bundle's {votes,k} shape). The
 * bundle admits iff `votes >= k`.
 *
 * FAIL-OPEN: `null` (no consensus signal ⇒ the bundle treats it as no objection)
 * when the reproducing set is empty, the quorum is non-positive, OR there is NO
 * DECISIVE evidence at all (every script crashed `other`/`exec_failed`/`unknown`
 * — 0 resolved AND 0 reproduced). Crucially, all-crashed must NOT collapse to
 * `votes:0` (which would REJECT the candidate on a broken script — a false-RED).
 * A vote IS emitted when at least one script is decisive: only
 * `outcome === "resolved"` counts toward `votes`, so a still-`reproduced` set
 * legitimately yields `votes:0` (bug not fixed = reject).
 */
export const resolvedConsensus = (
  samples: readonly ReproTestSample[],
  k: number,
): { votes: number; k: number } | null => {
  if (samples.length === 0 || k < 1) return null
  const vote = voteResolved(samples)
  // No decisive evidence either way ⇒ no signal (fail-open), NOT a 0-vote reject.
  if (vote.resolved === 0 && vote.reproduced === 0) return null
  return { votes: vote.resolved, k }
}

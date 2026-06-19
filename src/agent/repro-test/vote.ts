/**
 * Repro-test RESOLVED vote (validation-time majority).
 *
 * Agentless §3.3.1 closes the loop with the SAME repro set on both sides: a set
 * of candidate scripts reproduces the bug on the un-patched repo ("Issue
 * reproduced"), and a candidate fix is correct IFF those scripts now print
 * "Issue resolved" on the PATCHED tree. Selection (`select.ts`) already
 * majority-votes which script REPRODUCES; this module is the symmetric vote on
 * the RESOLVED side, run at validation time over the reproducing set.
 *
 * Why a vote (not the single selected script): the measured failure mode is a
 * false-NEGATIVE oracle — ONE brittle reproducer keeps printing "Issue
 * reproduced" (or crashes post-fix) even after a CORRECT patch, so a
 * single-script gate rejects the right fix and the repair loop churns
 * (measured: 46→131 turns re-deriving the same patch). Re-running the whole
 * reproducing set and majority-voting denoises that single brittle script:
 * independently-phrased scripts rarely share the same brittleness, so the
 * majority flips to "resolved" when the fix is real.
 *
 * Counting (decisive vs inconclusive):
 *   - `resolved`   — script flipped to "Issue resolved" (fix recognised).
 *   - `reproduced` — script still prints "Issue reproduced" (bug still present).
 *   - everything else (`other` / `exec_failed` / `unknown`) is INCONCLUSIVE —
 *     a post-fix crash or a no-op script is NOT evidence either way and must
 *     not be counted as a "still reproduced" vote (that would re-introduce the
 *     false-NEGATIVE we are removing).
 *
 * Verdict: strict majority of the DECISIVE votes. A tie (incl. 0 decisive /
 * empty input) is `inconclusive` so the caller can fall back to its legacy
 * single-sentinel / exit-code gate rather than guess. Pure, deterministic, no
 * I/O — fully unit-testable.
 */

import type { ReproTestSample } from "./types"

export type ReproResolvedVerdict = "resolved" | "reproduced" | "inconclusive"

export interface ReproVote {
  /** Strict-majority verdict over the decisive votes; tie ⇒ `inconclusive`. */
  verdict: ReproResolvedVerdict
  /** Count of samples that flipped to "Issue resolved". */
  resolved: number
  /** Count of samples that still print "Issue reproduced". */
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

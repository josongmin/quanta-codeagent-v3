/**
 * Phase A — Agentless-faithful patch acceptance + rerank selector (SOTA++).
 *
 * Pure reimplementation of `agentless/repair/rerank.py` `majority_voting`
 * (MIT, studied at .extracted_source/agentless-ref/). Selects among best-of-N
 * candidate patches, each scored ONCE by an acceptance oracle:
 *   - `reproPass`           — did the reproduction test report the issue resolved
 *                             (a per-candidate BOOLEAN, run once — NOT a per-round
 *                             K-of-N re-vote, which is the anti-pattern this fixes).
 *   - `regressionFailures`  — COUNT of failed regression tests (lower is better).
 *
 * Selection is a 3-tier fallback ladder over a PATCH-level majority vote:
 *   tier 1  repro-pass AND min-regression  → vote
 *   tier 2  (no tier-1 winner) drop repro, min-regression → vote
 *   tier 3  (still none, or both oracles off) vote over ALL non-empty patches
 *   none    every candidate patch is empty
 * `regression "pass"` is RELATIVE: a candidate passes when its failure count equals
 * the MINIMUM across all candidates (rerank.py:175-178). The vote is over the
 * normalized `patchKey`; the winner maximises (votes, then earliest appearance).
 *
 * Pure + deterministic: no I/O, no clock/random. No hidden SWE-bench field is read
 * (the oracle inputs are computed upstream from public tests only) — no-leak.
 */

export interface RerankCandidate {
  /** The patch we would submit if this candidate wins. */
  readonly patch: string
  /** Normalized vote key (AST-canonical upstream; raw patch is an acceptable
   *  fallback). Empty/whitespace ⇒ not votable. */
  readonly patchKey: string
  /** Optional structural tie-break priority. Higher is better. Used only when
   *  vote counts tie, before earliest appearance. Absent/0 preserves the legacy
   *  first-appearance tie-break. */
  readonly structuralPriority?: number
  /** COUNT of failed regression tests for this candidate (0 = none). Lower better;
   *  the bar is the MINIMUM across candidates, not absolute zero. */
  readonly regressionFailures: number
  /** Did the reproduction test report the issue resolved on this candidate. */
  readonly reproPass: boolean
}

export type RerankTier = "repro_and_regression" | "regression_only" | "all_patches" | "none"

export interface RerankResult {
  readonly patch: string
  readonly tier: RerankTier
  /** Vote count of the winning patchKey (0 when `tier === "none"`). */
  readonly votes: number
}

export interface RerankOpts {
  /** Use the regression failure-count guard. */
  readonly regression: boolean
  /** Use the reproduction boolean guard (implies the regression guard too). */
  readonly reproduction: boolean
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/** The three ranking keys a candidate is compared on, in priority order. */
interface VoteRank {
  readonly votes: number
  readonly priority: number
  readonly firstAppear: number
}

/** Project one candidate onto its ranking keys, defaulting every missing key to
 *  the same value the inline comparison used (`0`, and index 0 for an unseen
 *  patch key). A unit because these three lookups must stay in lockstep: the
 *  challenger and the incumbent have to be projected the SAME way or the
 *  comparison below silently stops being a total order. */
const voteRankOf = (
  candidate: RerankCandidate,
  votes: ReadonlyMap<string, number>,
  firstAppear: ReadonlyMap<string, number>,
): VoteRank => ({
  votes: votes.get(candidate.patchKey) ?? 0,
  priority: candidate.structuralPriority ?? 0,
  firstAppear: firstAppear.get(candidate.patchKey) ?? 0,
})

/** Does `challenger` beat the current best under the rerank ordering?
 *
 *  A unit because this is ONE total order stated three keys deep — more votes
 *  wins, ties go to the higher structural priority, remaining ties go to the
 *  EARLIER first appearance — which is exactly rerank.py's
 *  `max(key=lambda i: (vote[key], -first_appear_idx[key]))` plus our structural
 *  tiebreak. Every level compares STRICTLY, so a full tie never displaces the
 *  incumbent and the scan keeps its first-seen-wins behaviour. */
const beatsIncumbent = (challenger: VoteRank, incumbent: VoteRank): boolean =>
  challenger.votes > incumbent.votes ||
  (challenger.votes === incumbent.votes &&
    (challenger.priority > incumbent.priority ||
      (challenger.priority === incumbent.priority &&
        challenger.firstAppear < incumbent.firstAppear)))

/** Majority vote over the candidate ids: winner maximises (votes, -firstAppearance)
 *  — faithful to `max(key=lambda i: (vote[key], -first_appear_idx[key]))`. */
const voteWinner = (
  candidates: readonly RerankCandidate[],
  ids: readonly number[],
  tier: RerankTier,
): RerankResult => {
  const vote = new Map<string, number>()
  const firstAppear = new Map<string, number>()
  for (const i of ids) {
    const key = (candidates[i] as RerankCandidate).patchKey
    vote.set(key, (vote.get(key) ?? 0) + 1)
    if (!firstAppear.has(key)) firstAppear.set(key, i)
  }
  let best = ids[0] as number
  for (const i of ids) {
    const challenger = voteRankOf(candidates[i] as RerankCandidate, vote, firstAppear)
    const incumbent = voteRankOf(candidates[best] as RerankCandidate, vote, firstAppear)
    if (beatsIncumbent(challenger, incumbent)) best = i
  }
  const winner = candidates[best] as RerankCandidate
  return { patch: winner.patch, tier, votes: vote.get(winner.patchKey) ?? 0 }
}

/** The ADMISSIBLE set + its tier — the survivors of the 3-tier ladder, BEFORE the
 *  patch-vote tiebreak. Factored out so an optional async soft-reranker (LLM
 *  chooser/reviewer) can operate over EXACTLY this set: it can re-order admissible
 *  candidates but can never resurrect an inadmissible one (the never-veto invariant
 *  is structural — the soft-reranker only ever sees `ids`). `ids` empty ⇒ tier
 *  `none` (every patch empty). Pure; identical tiering to {@link rerankSelect}. */
export interface RerankAdmissible {
  readonly ids: readonly number[]
  readonly tier: RerankTier
}

export const selectAdmissible = (
  candidates: readonly RerankCandidate[],
  opts: RerankOpts,
): RerankAdmissible => {
  if (candidates.length === 0) return { ids: [], tier: "none" }
  const at = (i: number): RerankCandidate => candidates[i] as RerankCandidate
  const nonEmpty = (i: number): boolean => at(i).patchKey.trim() !== ""
  const ids = range(candidates.length)

  // regression bar is RELATIVE: the minimum failure count across candidates.
  const minFail = Math.min(...candidates.map((c) => c.regressionFailures))
  const passesRegression = (i: number): boolean => at(i).regressionFailures === minFail

  // tiered candidate selection (rerank.py:189-215).
  let selected: number[]
  let tier: RerankTier
  if (opts.regression && !opts.reproduction) {
    selected = ids.filter((i) => nonEmpty(i) && passesRegression(i))
    tier = "regression_only"
  } else if (opts.reproduction) {
    selected = ids.filter((i) => nonEmpty(i) && passesRegression(i) && at(i).reproPass)
    tier = "repro_and_regression"
    if (selected.length === 0) {
      selected = ids.filter((i) => nonEmpty(i) && passesRegression(i))
      tier = "regression_only"
    }
  } else {
    selected = ids.filter((i) => nonEmpty(i))
    tier = "all_patches"
  }

  // tier 3: nothing survived ⇒ vote over ALL non-empty patches (rerank.py:217-254).
  if (selected.length === 0) {
    const all = ids.filter((i) => nonEmpty(i))
    return all.length === 0 ? { ids: [], tier: "none" } : { ids: all, tier: "all_patches" }
  }
  return { ids: selected, tier }
}

export const rerankSelect = (
  candidates: readonly RerankCandidate[],
  opts: RerankOpts,
): RerankResult => {
  const { ids, tier } = selectAdmissible(candidates, opts)
  if (ids.length === 0) return { patch: "", tier: "none", votes: 0 }
  return voteWinner(candidates, ids, tier)
}

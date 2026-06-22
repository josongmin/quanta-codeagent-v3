/**
 * T-RESOLVE-14 — score-label taxonomy. The honest-expression rule made into a
 * typed enum so a benchmark receipt cannot SILENTLY claim more than its evidence
 * supports. Two buckets ("solved"/"miss") collapse a locally-graded green into
 * the same claim as an official-harness resolve — that conflation is exactly what
 * lets contaminated/heuristic wins masquerade as clean leaderboard score.
 *
 * Three explicit labels, strongest → weakest:
 *   - `official_harness`      — applied patch graded by the official SWE-bench
 *                               harness (FAIL_TO_PASS + PASS_TO_PASS in-container).
 *                               The ONLY label reportable as leaderboard resolved.
 *   - `local_structural`      — executed local witness/keep-green/repro green, but
 *                               NOT the official harness. A legitimate intermediate
 *                               claim; never reported as official.
 *   - `research_contaminated` — any run touching a research knob/preset
 *                               (`research/*`, declaredExpected authority,
 *                               repro-doubt, discovered-regression magic score).
 *                               Never reported as clean.
 *
 * Core rule: a receipt's label is the WEAKEST of its inputs — research-
 * contamination dominates, and `local_structural` never auto-promotes to
 * `official_harness` without an actual harness run. Pure + deterministic.
 */

import type { BenchPosture } from "./knobs-bench"

export type ScoreLabel = "official_harness" | "local_structural" | "research_contaminated"

/** Strength rank (higher = stronger claim). */
const RANK: Record<ScoreLabel, number> = {
  research_contaminated: 0,
  local_structural: 1,
  official_harness: 2,
}

/** The evidence a receipt actually has. No field can be inferred from another. */
export interface ReceiptEvidence {
  /** The patch was graded by the official SWE-bench harness and resolved. */
  readonly officialHarnessResolved: boolean
  /** An executed local witness / keep-green / repro consensus came back green. */
  readonly localExecutedGreen: boolean
  /** The run touched a research-only authority knob (declaredExpected gates,
   *  live LLM risk veto, repro-doubt, non-witness regression source). */
  readonly researchKnobTouched: boolean
}

export type ResearchContaminationPosture = Pick<
  BenchPosture,
  "verifySelectLlmRiskGate" | "verifySelectRegression" | "reproDoubt"
>

/** `discovered` is the executed-witness path and is admissible in clean mode.
 *  Any other explicit regression source is an answer-key / magic-score signal. */
export const isContaminatingRegressionSource = (
  mode: ResearchContaminationPosture["verifySelectRegression"],
): boolean => mode !== undefined && mode !== "discovered"

/** Closed set of research-only authority reasons. One SSOT used by the runtime
 *  scorer and the preset allowlist ratchet. */
export const researchContaminationReasons = (
  posture: ResearchContaminationPosture,
): readonly string[] => {
  const reasons: string[] = []
  if (posture.verifySelectLlmRiskGate === "on") reasons.push("verify-select-llm-risk-gate=on")
  if (posture.reproDoubt) reasons.push("repro-doubt")
  if (isContaminatingRegressionSource(posture.verifySelectRegression)) {
    reasons.push("verify-select-regression(magic-score)")
  }
  return reasons
}

export const researchKnobTouched = (posture: ResearchContaminationPosture): boolean =>
  researchContaminationReasons(posture).length > 0

/**
 * Derive the receipt's label from its evidence — the WEAKEST justified claim.
 * Research contamination dominates everything; absent any positive executed
 * evidence a receipt is NOT clean (defaults to `research_contaminated` rather
 * than silently counting).
 */
export const labelForReceipt = (e: ReceiptEvidence): ScoreLabel => {
  if (e.researchKnobTouched) return "research_contaminated"
  if (e.officialHarnessResolved) return "official_harness"
  if (e.localExecutedGreen) return "local_structural"
  return "research_contaminated"
}

/** Combine input labels into one receipt label = the WEAKEST (lowest rank). */
export const weakestLabel = (labels: readonly ScoreLabel[]): ScoreLabel => {
  if (labels.length === 0) return "research_contaminated"
  return labels.reduce((weakest, l) => (RANK[l] < RANK[weakest] ? l : weakest))
}

/** Only an `official_harness` receipt may count toward the leaderboard headline. */
export const countsAsOfficialClean = (label: ScoreLabel): boolean => label === "official_harness"

/**
 * No silent upgrade: a label may only be promoted to a stronger one when the
 * actually-stronger evidence is present. `official_harness` requires a harness
 * run; `local_structural` requires executed-green; any research contamination
 * forbids upgrading above `research_contaminated`.
 */
export const canPromoteLabel = (to: ScoreLabel, e: ReceiptEvidence): boolean => {
  if (e.researchKnobTouched) return to === "research_contaminated"
  if (to === "official_harness") return e.officialHarnessResolved
  if (to === "local_structural") return e.localExecutedGreen
  return true
}

/** The leaderboard headline = number of `official_harness` receipts. Computed
 *  from the receipts, never hand-edited. */
export const officialCleanCount = (labels: readonly ScoreLabel[]): number =>
  labels.filter(countsAsOfficialClean).length

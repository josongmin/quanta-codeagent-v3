/**
 * TA — VerificationBundle pure core: `scoreCandidate` / `selectBest`.
 *
 * Pure, deterministic, I/O-free — the verdict authority's decision logic.
 *
 * HARD GATE (admissibility) = AND of the four hard signals, each REJECTING
 * only on explicit negative evidence; every nullable signal is FAIL-OPEN:
 *   - `baseValidatedRed === false`                    → reject (`null` ⇒ pass)
 *   - `applyClean === false`                          → reject
 *   - `patchedResolvedKofN` present && `votes < k`    → reject (null ⇒ pass)
 *   - `regressionGreen === false`                     → reject (null ⇒ pass)
 *
 * SOFT SCORE = weighted sum of the available soft signals. Weights are
 * deliberately near-equal conservative constants: per the no-heuristics rule,
 * weight TUNING happens only AFTER the A/B measurement, never up front. A
 * `null` soft signal contributes nothing AND does not shrink the denominator
 * in a way that punishes missing data — we sum `weight * value` over present
 * signals only.
 *
 * `selectBest` returns the highest-scoring ADMISSIBLE candidate (ties broken by
 * first appearance — minimality already lives inside the score), or `null` when
 * none is admissible (the caller then submits a best-effort pick by raw score).
 */

import type { CandidateVerdict, HardGateSignals, ScoredCandidate, SoftScoreSignals } from "./types"

/** Near-equal conservative soft weights (pre-measurement; tune only after A/B). */
const SOFT_WEIGHTS = {
  declaredExpectedMatch: 0.25,
  rubricScore: 0.2,
  voterQuorum: 0.2,
  minimality: 0.15,
  ownerCoverage: 0.2,
} as const

/** Coerce a soft signal to a [0,1] number; booleans map to 1/0; out-of-range
 *  numbers are CLAMPED to [0,1]; non-finite (NaN/±Infinity) ⇒ `null` (dropped
 *  as unavailable — a garbage rubric must not corrupt the score or, via NaN,
 *  the order-dependent `selectBest` comparison). */
const softValue = (v: boolean | number | null): number | null => {
  if (v === null) return null
  if (typeof v === "boolean") return v ? 1 : 0
  if (!Number.isFinite(v)) return null
  return Math.min(1, Math.max(0, v))
}

/**
 * Score one candidate. Pure. The four hard gates are AND-ed with the fail-open
 * rule; the soft score is a weighted sum over present signals.
 */
export const scoreCandidate = (hard: HardGateSignals, soft: SoftScoreSignals): CandidateVerdict => {
  const reasons: string[] = []

  // ── HARD GATE (AND; null = fail-open) ────────────────────────────────────
  let admissible = true
  if (hard.baseValidatedRed === false) {
    admissible = false
    reasons.push("hard:baseValidatedRed=false (no validated repro authority)")
  }
  if (hard.applyClean === false) {
    admissible = false
    reasons.push("hard:applyClean=false (patch did not apply)")
  }
  if (hard.patchedResolvedKofN !== null) {
    const { votes, k } = hard.patchedResolvedKofN
    if (votes < k) {
      admissible = false
      reasons.push(`hard:patchedResolvedKofN votes=${votes}<k=${k}`)
    }
  }
  if (hard.regressionGreen === false) {
    admissible = false
    reasons.push("hard:regressionGreen=false (candidate regressed a test)")
  }

  // ── SOFT SCORE (weighted sum over present signals) ───────────────────────
  let score = 0
  for (const key of Object.keys(SOFT_WEIGHTS) as (keyof SoftScoreSignals)[]) {
    const value = softValue(soft[key])
    if (value !== null) {
      score += SOFT_WEIGHTS[key] * value
      reasons.push(`soft:${key}=${value}`)
    }
  }

  return { admissible, score, reasons }
}

/**
 * Pick the best candidate. Highest-scoring ADMISSIBLE candidate wins; ties go
 * to first appearance (minimality is already folded into the score). Returns
 * `null` when no candidate is admissible — the caller submits a best-effort
 * pick (e.g. raw `selectBestEffort`) rather than nothing.
 */
export const selectBest = (cands: readonly ScoredCandidate[]): string | null => {
  let best: ScoredCandidate | null = null
  for (const c of cands) {
    if (!c.verdict.admissible) continue
    if (best === null || c.verdict.score > best.verdict.score) best = c
  }
  return best?.id ?? null
}

/**
 * Best-effort fallback: highest raw score regardless of admissibility, for when
 * {@link selectBest} returns `null`. Ties → first appearance. `null` only on an
 * empty input. The caller uses this to never submit *nothing* when an answer
 * exists — the hard gates inform but do not dictate the final submission.
 */
export const selectBestEffort = (cands: readonly ScoredCandidate[]): string | null => {
  let best: ScoredCandidate | null = null
  for (const c of cands) {
    if (best === null || c.verdict.score > best.verdict.score) best = c
  }
  return best?.id ?? null
}

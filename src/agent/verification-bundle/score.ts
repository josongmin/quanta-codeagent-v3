/**
 * TA — VerificationBundle pure core: `scoreCandidate` / `selectBest`.
 *
 * Pure, deterministic, I/O-free — the verdict authority's decision logic.
 *
 * HARD GATE (admissibility) = AND of the five hard signals, each REJECTING
 * only on explicit negative evidence; every nullable signal is FAIL-OPEN:
 *   - `baseValidatedRed === false`                    → reject (`null` ⇒ pass)
 *   - `patchProduced === false`                       → reject
 *   - `applyClean === false`                          → reject (`null` ⇒ pass)
 *   - `patchedResolvedKofN` present but malformed      → reject (null ⇒ pass)
 *   - `patchedResolvedKofN` present && `votes < k`    → reject (null ⇒ pass)
 *   - `regressionGreen === false`                     → reject (null ⇒ pass)
 *   - `smokeGreen === false`                          → reject (`null` ⇒ pass)
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
 * none is admissible. Callers may layer a constrained best-effort fallback, but
 * only outside the bundle.
 */

import { isValidResolvedKofN } from "./resolved-kofn"
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
 * `voterQuorum` arrives as the consensus RATIO `votes / k` (resolved-kofn.ts),
 * which is ≥ 1 whenever super-quorum (more reproducing voters resolved than the
 * quorum threshold). The generic `softValue` clamp would saturate every value
 * ≥ 1 to exactly 1, conflating an exact-quorum candidate (votes=k) with a
 * super-quorum one (votes=3k) — the soft ranking could then never prefer the
 * stronger-consensus patch, throwing away the discrimination the signal exists
 * to provide.
 *
 * Instead squash the ratio with the strictly-increasing bounded map
 * `r ↦ r / (r + 1)` (a parameter-free logistic-family normalizer, no arbitrary
 * threshold): sub-quorum stays ordered (0.5 ↦ 0.333), exact-quorum is 0.5, and
 * super-quorum is strictly higher (3 ↦ 0.75, 10 ↦ 0.909) yet always < 1. So
 * `votes=k` and `votes=3k` produce DISTINCT, correctly-ordered signals.
 *
 * `null`/non-finite/negative defer to the generic coercion (drop / clamp to 0).
 */
const voterQuorumValue = (v: number | null): number | null => {
  if (v === null) return null
  if (!Number.isFinite(v) || v <= 0) return softValue(v)
  return v / (v + 1)
}

/**
 * Score one candidate. Pure. The hard gates are AND-ed with the fail-open
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
  if (hard.patchProduced === false) {
    admissible = false
    reasons.push("hard:patchProduced=false (empty patch)")
  }
  if (hard.applyClean === false) {
    admissible = false
    reasons.push("hard:applyClean=false (patch did not apply)")
  }
  if (hard.patchedResolvedKofN !== null) {
    const { votes, k } = hard.patchedResolvedKofN
    if (!isValidResolvedKofN(hard.patchedResolvedKofN)) {
      admissible = false
      reasons.push(`hard:patchedResolvedKofN invalid payload votes=${votes},k=${k}`)
    } else if (votes < k) {
      admissible = false
      reasons.push(`hard:patchedResolvedKofN votes=${votes}<k=${k}`)
    }
  }
  if (hard.regressionGreen === false) {
    admissible = false
    reasons.push("hard:regressionGreen=false (candidate regressed a test)")
  }
  if (hard.smokeGreen === false) {
    admissible = false
    reasons.push("hard:smokeGreen=false (candidate broke a public smoke)")
  }

  // ── SOFT SCORE (weighted sum over present signals) ───────────────────────
  // `voterQuorum` is the consensus RATIO (votes/k, super-quorum ⇒ >1) and uses a
  // dedicated bounded squash so super-quorum stays distinguishable from exact
  // quorum instead of saturating to 1; every other signal is a plain [0,1] coerce.
  let score = 0
  for (const key of Object.keys(SOFT_WEIGHTS) as (keyof SoftScoreSignals)[]) {
    const raw = soft[key]
    const value = key === "voterQuorum" ? voterQuorumValue(raw as number | null) : softValue(raw)
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
 * `null` when no candidate is admissible.
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

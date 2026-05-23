/**
 * Pure scorer + selector for speculative branch search (ADR-0084). No IO, no
 * clock — given verifier signals, fold to a 0..1 total and pick argmax.
 * Deterministic for a fixed signal set (non-determinism lives in propose).
 */

import type {
  BranchCandidate,
  CandidateScore,
  Scorer,
  Selector,
  VerifierKind,
  VerifierSignal,
} from "./types"

/** Default per-kind weights. Sum need NOT be 1 — `scoreWith` normalizes by the
 *  weight mass of NON-penalty kinds present. `patch_size` is a PENALTY
 *  (subtracted, scaled by its magnitude). */
export const DEFAULT_WEIGHTS: Readonly<Record<VerifierKind, number>> = Object.freeze({
  tsc: 0.4,
  test: 0.4,
  lint: 0.1,
  lsp_diag: 0.2,
  llm_judge: 0.2,
  patch_size: 0.1,
})

const PENALTY_KINDS: ReadonlySet<VerifierKind> = new Set<VerifierKind>(["patch_size"])

const signalValue = (s: VerifierSignal): number => {
  if (s.magnitude !== undefined) return Math.max(0, Math.min(1, s.magnitude))
  return s.pass ? 1 : 0
}

export const makeScorer = (overrides?: Partial<Record<VerifierKind, number>>): Scorer => {
  const weights: Record<VerifierKind, number> = { ...DEFAULT_WEIGHTS, ...overrides }
  return (signals) => scoreWith(weights, signals)
}

export const defaultScorer: Scorer = makeScorer()

const scoreWith = (
  weights: Record<VerifierKind, number>,
  signals: ReadonlyArray<VerifierSignal>,
): CandidateScore => {
  if (signals.length === 0) return { total: 0, breakdown: [] }
  let rewardNum = 0
  let rewardDen = 0
  let penalty = 0
  for (const s of signals) {
    const w = weights[s.kind] ?? 0
    if (PENALTY_KINDS.has(s.kind)) {
      penalty += w * signalValue(s)
      continue
    }
    rewardNum += w * signalValue(s)
    rewardDen += w
  }
  const reward = rewardDen > 0 ? rewardNum / rewardDen : 0
  const total = Math.max(0, Math.min(1, reward - penalty))
  return { total, breakdown: [...signals] }
}

const totalMs = (signals: ReadonlyArray<VerifierSignal>): number =>
  signals.reduce((acc, s) => acc + s.durationMs, 0)

/**
 * Argmax selector with deterministic tie-break: total ↓, then verifier-ms ↑
 * (faster = simpler proxy), then lexicographic id (stable replay). Throws on
 * empty input — the orchestrator guarantees ≥1 candidate.
 */
export const argmaxSelector: Selector = (scored) => {
  if (scored.length === 0) throw new Error("argmaxSelector: no candidates to select from")
  const sorted = [...scored].sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    const aMs = totalMs(a.score.breakdown)
    const bMs = totalMs(b.score.breakdown)
    if (aMs !== bMs) return aMs - bMs
    return a.cand.id < b.cand.id ? -1 : a.cand.id > b.cand.id ? 1 : 0
  })
  return (sorted[0] as { cand: BranchCandidate; score: CandidateScore }).cand
}

const deltaSize = (c: BranchCandidate): number =>
  c.delta === undefined ? Number.POSITIVE_INFINITY : c.delta.addedLines + c.delta.removedLines

/** Stable tied-candidate comparator used by `minimalChangeSelector`. Guards
 *  against `+Inf - +Inf = NaN` (which would produce a non-total ordering)
 *  by treating equal deltas — including both `+Inf` — as "no preference",
 *  then falling through to: baseWinner first → lexicographic id. Pure. */
const compareTied =
  (baseWinnerId: string) =>
  (
    a: { cand: BranchCandidate; score: CandidateScore },
    b: { cand: BranchCandidate; score: CandidateScore },
  ): number => {
    const da = deltaSize(a.cand)
    const db = deltaSize(b.cand)
    if (da !== db) return da - db
    if (a.cand.id === baseWinnerId) return -1
    if (b.cand.id === baseWinnerId) return 1
    return a.cand.id < b.cand.id ? -1 : a.cand.id > b.cand.id ? 1 : 0
  }

/** Tiebreak selector — wraps a base selector (default `argmaxSelector`).
 *  When the base winner has ties within `epsilon` of its total, picks the
 *  candidate with smallest total `delta` (addedLines + removedLines).
 *  Missing delta = treated as +Infinity (loses to any candidate with a
 *  delta). Pure, deterministic. */
export const minimalChangeSelector =
  (base: Selector = argmaxSelector, epsilon = 1e-6): Selector =>
  (scored) => {
    if (scored.length === 0) throw new Error("minimalChangeSelector: empty scored")
    const baseWinner = base(scored)
    const baseEntry = scored.find((s) => s.cand.id === baseWinner.id)
    if (baseEntry === undefined) return baseWinner
    const baseTotal = baseEntry.score.total
    const tied = scored.filter((s) => Math.abs(s.score.total - baseTotal) < epsilon)
    if (tied.length <= 1) return baseWinner
    const sorted = [...tied].sort(compareTied(baseWinner.id))
    return (sorted[0] as { cand: BranchCandidate; score: CandidateScore }).cand
  }

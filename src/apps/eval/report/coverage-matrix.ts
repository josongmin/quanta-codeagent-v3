/**
 * Aggregate every persisted `EvalRecord` across every tier into a single
 * (UseCase × Tier) coverage matrix. Each cell is the best observed verdict
 * for that pair (`pass > partial > fail > skipped`); audit cells map
 * coverage levels into the same lattice (`ok→pass`, `partial→partial`,
 * `no→fail`, `tbd→skipped`).
 */

import { assertNever } from "@/shared"
import type { EvalRecord } from "../storage"
import { allLeaves, leafById, parseId, TAXONOMY } from "../taxonomy"
import type { CoverageLevel, EvalTier, UseCaseId, Verdict } from "../types"

const TIER_ORDER: readonly EvalTier[] = [
  "audit",
  "synthetic",
  "grounding",
  "public",
  "trajectory",
  "compare",
]

const VERDICT_RANK: Record<Verdict, number> = {
  pass: 4,
  partial: 3,
  fail: 2,
  error: 1,
  skipped: 0,
}

const COVERAGE_TO_VERDICT: Record<CoverageLevel, Verdict> = {
  ok: "pass",
  partial: "partial",
  no: "fail",
  tbd: "skipped",
}

export interface MatrixCell {
  verdict: Verdict
  /** Number of records contributing. */
  count: number
}

export interface UseCaseRow {
  id: UseCaseId
  /** Mid-label for grouping in the rendered view. */
  midLabel: string
  /** Cells keyed by tier. */
  cells: Record<EvalTier, MatrixCell>
}

export interface MajorBlock {
  majorId: string
  label: string
  /** Optional empirical share for column header. */
  share?: number
  rows: readonly UseCaseRow[]
}

/** ADR-0087 — token + cost rollup summed over every payload that carries the
 *  additive `tokens`/`costUsd` fields (synthetic + grounding + public). Absent from the
 *  matrix entirely when NO record reported any usage, so the rendered report is
 *  byte-identical to the pre-feature path on a usage-free corpus. */
export interface TokenCostRollup {
  prompt: number
  completion: number
  cacheRead: number
  /** Summed measured USD over records that carried a `costUsd`. */
  costUsd: number
  /** Number of records that contributed token data (for averaging upstream). */
  records: number
}

/** W0.6 / G-F15 — pricing completeness of {@link TokenCostRollup}. Sibling so
 *  existing `{prompt,completion,cacheRead,costUsd,records}` equality stays
 *  stable. */
export type EvalCostCompleteness = "complete" | "partial" | "unavailable"

export interface EvalCostPricing {
  readonly completeness: EvalCostCompleteness
  readonly knownSubtotalUsd: number
  readonly pricedRecords: number
  readonly unpricedRecords: number
}

export interface EvalCostProjection {
  readonly headlineCost: string
  readonly detailCost: string
}

/** Shared headline/detail projection. Completeness is required: a missing
 *  stamp must not collapse to measured `$0`. */
export const projectEvalCost = (
  tokenCost: TokenCostRollup,
  pricing: EvalCostPricing,
): EvalCostProjection => {
  void tokenCost
  if (pricing.completeness === "unavailable") {
    return { headlineCost: "unavailable", detailCost: "unavailable" }
  }
  const dollars = `$${pricing.knownSubtotalUsd.toFixed(4)}`
  if (pricing.completeness === "partial") {
    return {
      headlineCost: `${dollars} (partial)`,
      detailCost: `${dollars} (partial, ${pricing.unpricedRecords} unpriced)`,
    }
  }
  return { headlineCost: dollars, detailCost: dollars }
}

export interface CoverageMatrix {
  /** Order matches TAXONOMY. */
  blocks: readonly MajorBlock[]
  /** Tier columns in render order. */
  tiers: readonly EvalTier[]
  /** Run summary line counts (records seen). */
  recordsSeen: number
  /** ADR-0087 — aggregate token/cost rollup; absent when no record had usage. */
  tokenCost?: TokenCostRollup
  /** G-F15 — completeness of `tokenCost`. Present iff `tokenCost` is. */
  costPricing?: EvalCostPricing
}

const verdictFromRecord = (rec: EvalRecord): Verdict => {
  const p = rec.payload
  switch (p.kind) {
    case "audit":
      return COVERAGE_TO_VERDICT[p.coverage]
    case "synthetic":
      return p.verdict
    case "grounding":
      return p.verdict
    case "public":
      return p.verdict
    case "trajectory":
      // Presence of a trajectory record == we saw real usage of this UseCase.
      // `pass` semantics: "real evidence exists", not "agent succeeded".
      return "pass"
    case "compare":
      if (p.winner === 0) return "pass"
      if (p.winner === -1) return "partial"
      return "fail"
    default:
      return assertNever(p)
  }
}

const emptyCell = (): MatrixCell => ({ verdict: "skipped", count: 0 })

/** A fresh all-tier cell row. A unit because the six-key literal was spelled
 *  out TWICE (new-usecase seed, and the taxonomy-walk default) — one table, one
 *  place to add a tier. */
const emptyRow = (): Record<EvalTier, MatrixCell> => ({
  audit: emptyCell(),
  synthetic: emptyCell(),
  grounding: emptyCell(),
  public: emptyCell(),
  trajectory: emptyCell(),
  compare: emptyCell(),
})

/** ADR-0087 — fold one record's token/cost usage into the running rollup.
 *  A unit because it is the only mutation of `roll`, and its three-way payload
 *  kind test was the largest single boolean sequence in the parent. Mutates
 *  `roll` in place (rather than returning a new one) so the accumulation order
 *  and float summation stay bit-for-bit what the inline version did. */
const accumulateTokenCost = (
  roll: TokenCostRollup,
  counts: { priced: number; unpriced: number },
  p: EvalRecord["payload"],
): void => {
  if (p.kind !== "synthetic" && p.kind !== "grounding" && p.kind !== "public") return
  if (p.tokens === undefined) return
  roll.prompt += p.tokens.prompt
  roll.completion += p.tokens.completion
  roll.cacheRead += p.tokens.cacheRead ?? 0
  if (typeof p.costUsd === "number") {
    roll.costUsd += p.costUsd
    counts.priced += 1
  } else {
    counts.unpriced += 1
  }
  roll.records += 1
}

/** Fold one record into its (usecase × tier) cell, seeding the row on first
 *  sight. A unit because "find-or-create the row, then max-merge the verdict"
 *  is a single lattice operation; inlined it added a nested `if` to a loop that
 *  already carried the rollup. */
const tallyRecord = (
  byUsecase: Map<UseCaseId, Record<EvalTier, MatrixCell>>,
  rec: EvalRecord,
): void => {
  const id = rec.usecase
  let row = byUsecase.get(id)
  if (row === undefined) {
    row = emptyRow()
    byUsecase.set(id, row)
  }
  const v = verdictFromRecord(rec)
  const cell = row[rec.tier]
  cell.count += 1
  if (VERDICT_RANK[v] > VERDICT_RANK[cell.verdict]) cell.verdict = v
}

/** Project the tallied map onto the TAXONOMY skeleton, in taxonomy order.
 *  A unit because it is a pure three-deep walk (major → mid → leaf) whose
 *  nesting surcharge alone was worth ~6 points inside the parent, and it does
 *  not touch the rollup at all. */
const buildBlocks = (
  byUsecase: Map<UseCaseId, Record<EvalTier, MatrixCell>>,
): readonly MajorBlock[] => {
  const blocks: MajorBlock[] = []
  for (const maj of TAXONOMY) {
    const rows: UseCaseRow[] = []
    for (const m of maj.mids) {
      for (const l of m.leaves) {
        rows.push({ id: l.id, midLabel: m.label, cells: byUsecase.get(l.id) ?? emptyRow() })
      }
    }
    blocks.push({
      majorId: maj.id,
      label: maj.label,
      ...(maj.empiricalShare !== undefined ? { share: maj.empiricalShare } : {}),
      rows,
    })
  }
  return blocks
}

export const buildCoverageMatrix = (records: Iterable<EvalRecord>): CoverageMatrix => {
  const byUsecase = new Map<UseCaseId, Record<EvalTier, MatrixCell>>()
  let seen = 0
  // ADR-0087 — running token/cost rollup. `roll.records` stays 0 until a
  // synthetic/grounding/public payload carries `tokens`, at which point the rollup is
  // attached; an all-usage-free corpus leaves `tokenCost` undefined.
  const roll: TokenCostRollup = {
    prompt: 0,
    completion: 0,
    cacheRead: 0,
    costUsd: 0,
    records: 0,
  }
  const costCounts = { priced: 0, unpriced: 0 }
  for (const rec of records) {
    seen += 1
    accumulateTokenCost(roll, costCounts, rec.payload)
    tallyRecord(byUsecase, rec)
  }
  // Mark unknown / unclassified (trajectory uses "unclassified" sentinel id).
  // We intentionally drop them from the matrix here — `report/trend` surfaces
  // a top-line count instead.
  void leafById
  void parseId
  void allLeaves
  const costPricing: EvalCostPricing | undefined =
    roll.records > 0
      ? {
          completeness:
            costCounts.unpriced === 0
              ? "complete"
              : costCounts.priced === 0
                ? "unavailable"
                : "partial",
          knownSubtotalUsd: roll.costUsd,
          pricedRecords: costCounts.priced,
          unpricedRecords: costCounts.unpriced,
        }
      : undefined
  if (roll.records > 0 && costPricing !== undefined) {
    return {
      blocks: buildBlocks(byUsecase),
      tiers: TIER_ORDER,
      recordsSeen: seen,
      tokenCost: roll,
      costPricing,
    }
  }
  return {
    blocks: buildBlocks(byUsecase),
    tiers: TIER_ORDER,
    recordsSeen: seen,
  }
}

/**
 * Aggregate every persisted `EvalRecord` across every tier into a single
 * (UseCase × Tier) coverage matrix. Each cell is the best observed verdict
 * for that pair (`pass > partial > fail > skipped`); audit cells map
 * coverage levels into the same lattice (`ok→pass`, `partial→partial`,
 * `no→fail`, `tbd→skipped`).
 */

import type { EvalRecord } from "../storage"
import { allLeaves, leafById, parseId, TAXONOMY } from "../taxonomy"
import type { CoverageLevel, EvalTier, UseCaseId, Verdict } from "../types"

const TIER_ORDER: readonly EvalTier[] = ["audit", "synthetic", "public", "trajectory", "compare"]

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

export interface CoverageMatrix {
  /** Order matches TAXONOMY. */
  blocks: readonly MajorBlock[]
  /** Tier columns in render order. */
  tiers: readonly EvalTier[]
  /** Run summary line counts (records seen). */
  recordsSeen: number
}

/** Exhaustiveness sentinel: a `never` parameter forces the switch above to
 *  cover every union arm at compile time. If a new `payload.kind` is added to
 *  `storage/schema.ts` without a corresponding case here, this call site is
 *  the type error. */
const assertNever = (x: never): never => {
  throw new Error(`unhandled payload kind: ${JSON.stringify(x)}`)
}

const verdictFromRecord = (rec: EvalRecord): Verdict => {
  const p = rec.payload
  switch (p.kind) {
    case "audit":
      return COVERAGE_TO_VERDICT[p.coverage]
    case "synthetic":
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

export const buildCoverageMatrix = (records: Iterable<EvalRecord>): CoverageMatrix => {
  const byUsecase = new Map<UseCaseId, Record<EvalTier, MatrixCell>>()
  let seen = 0
  for (const rec of records) {
    seen += 1
    const id = rec.usecase
    let row = byUsecase.get(id)
    if (row === undefined) {
      row = {
        audit: emptyCell(),
        synthetic: emptyCell(),
        public: emptyCell(),
        trajectory: emptyCell(),
        compare: emptyCell(),
      }
      byUsecase.set(id, row)
    }
    const v = verdictFromRecord(rec)
    const cell = row[rec.tier]
    cell.count += 1
    if (VERDICT_RANK[v] > VERDICT_RANK[cell.verdict]) cell.verdict = v
  }
  const blocks: MajorBlock[] = []
  for (const maj of TAXONOMY) {
    const rows: UseCaseRow[] = []
    for (const m of maj.mids) {
      for (const l of m.leaves) {
        const cells = byUsecase.get(l.id) ?? {
          audit: emptyCell(),
          synthetic: emptyCell(),
          public: emptyCell(),
          trajectory: emptyCell(),
          compare: emptyCell(),
        }
        rows.push({ id: l.id, midLabel: m.label, cells })
      }
    }
    blocks.push({
      majorId: maj.id,
      label: maj.label,
      ...(maj.empiricalShare !== undefined ? { share: maj.empiricalShare } : {}),
      rows,
    })
  }
  // Mark unknown / unclassified (trajectory uses "unclassified" sentinel id).
  // We intentionally drop them from the matrix here — `report/trend` surfaces
  // a top-line count instead.
  void leafById
  void parseId
  void allLeaves
  return { blocks, tiers: TIER_ORDER, recordsSeen: seen }
}

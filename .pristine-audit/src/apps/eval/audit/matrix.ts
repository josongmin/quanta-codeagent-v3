/**
 * Roll up `AuditFinding`s into a `(major × CoverageLevel)` matrix. Pure data
 * shaping — rendering lives in `report/coverage-matrix.ts`.
 */
import { parseId, TAXONOMY } from "../taxonomy"
import type { CoverageLevel } from "../types"
import type { AuditFinding } from "./grep-mapper"

export interface MajorRow {
  majorId: string
  label: string
  /** Counts per coverage level for this major. */
  counts: Record<CoverageLevel, number>
  total: number
}

export interface AuditMatrix {
  /** One row per major, in TAXONOMY order. */
  rows: readonly MajorRow[]
  /** Aggregated counts across all majors. */
  totals: { counts: Record<CoverageLevel, number>; total: number }
}

const emptyCounts = (): Record<CoverageLevel, number> => ({ ok: 0, partial: 0, no: 0, tbd: 0 })

export const buildMatrix = (findings: readonly AuditFinding[]): AuditMatrix => {
  const byMajor = new Map<string, MajorRow>()
  for (const maj of TAXONOMY) {
    byMajor.set(maj.id, { majorId: maj.id, label: maj.label, counts: emptyCounts(), total: 0 })
  }
  const totalsCounts = emptyCounts()
  let total = 0
  for (const f of findings) {
    const segs = parseId(f.usecase)
    if (segs === null) continue
    const row = byMajor.get(segs.major)
    if (row === undefined) continue
    row.counts[f.coverage] += 1
    row.total += 1
    totalsCounts[f.coverage] += 1
    total += 1
  }
  return { rows: [...byMajor.values()], totals: { counts: totalsCounts, total } }
}

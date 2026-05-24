/**
 * Hellgate — coverage report merge (ADR-0173).
 *
 * Seals (8+ cases): identity, max-numerator-per-file, multi-file union,
 * shape-drift detection, empty input identity, totals re-aggregation,
 * uncoveredLines intersection, stable file ordering.
 */

import { describe, expect, test } from "bun:test"
import { CoverageError, type CoverageReport, mergeCoverageReports } from "@/observability/coverage"

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

const fileEntry = (
  file: string,
  linesCovered: number,
  lineCount: number,
  branchesCovered: number,
  branchCount: number,
  uncoveredLines: number[] = [],
) => ({
  file,
  lineCount,
  linesCovered,
  linesPercent: safePercent(linesCovered, lineCount),
  branchCount,
  branchesCovered,
  branchesPercent: safePercent(branchesCovered, branchCount),
  statementCount: lineCount,
  statementsCovered: linesCovered,
  statementsPercent: safePercent(linesCovered, lineCount),
  uncoveredLines,
})

const reportOf = (...files: Array<ReturnType<typeof fileEntry>>): CoverageReport => {
  let linesC = 0
  let lineCt = 0
  let brC = 0
  let brCt = 0
  for (const f of files) {
    linesC += f.linesCovered
    lineCt += f.lineCount
    brC += f.branchesCovered
    brCt += f.branchCount
  }
  return {
    files,
    totals: {
      linesPercent: safePercent(linesC, lineCt),
      branchesPercent: safePercent(brC, brCt),
      statementsPercent: safePercent(linesC, lineCt),
      fileCount: files.length,
    },
    generatedAt: Date.now(),
  }
}

// ────────────────────────────────────────────────────────────────────────────
describe("coverage / merge", () => {
  test("HELL-26: single report → identity merge (same files, same counts)", () => {
    const r = reportOf(fileEntry("/a.ts", 8, 10, 2, 3))
    const merged = mergeCoverageReports([r])
    expect(merged.files).toHaveLength(1)
    expect(merged.files[0]?.linesCovered).toBe(8)
    expect(merged.files[0]?.branchesCovered).toBe(2)
  })

  test("HELL-27: two reports same file, max-numerator semantics", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3))
    const r2 = reportOf(fileEntry("/a.ts", 8, 10, 2, 3))
    const merged = mergeCoverageReports([r1, r2])
    expect(merged.files).toHaveLength(1)
    // Max-numerator: linesCovered should be at least 8 (the larger shard).
    expect(merged.files[0]?.linesCovered).toBeGreaterThanOrEqual(8)
    expect(merged.files[0]?.branchesCovered).toBe(2)
  })

  test("HELL-28: different files → union (both keys appear)", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3))
    const r2 = reportOf(fileEntry("/b.ts", 3, 5, 0, 1))
    const merged = mergeCoverageReports([r1, r2])
    expect(merged.files).toHaveLength(2)
    const paths = merged.files.map((f) => f.file).sort()
    expect(paths).toEqual(["/a.ts", "/b.ts"])
  })

  test("HELL-29: shape drift — same file, different branchCount → throws", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3))
    const r2 = reportOf(fileEntry("/a.ts", 5, 10, 1, 4))
    expect(() => mergeCoverageReports([r1, r2])).toThrow(CoverageError)
  })

  test("HELL-30: shape drift — same file, different lineCount → throws", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3))
    const r2 = reportOf(fileEntry("/a.ts", 5, 11, 1, 3))
    expect(() => mergeCoverageReports([r1, r2])).toThrow(CoverageError)
  })

  test("HELL-31: empty array → empty report (identity element)", () => {
    const merged = mergeCoverageReports([])
    expect(merged.files).toHaveLength(0)
    expect(merged.totals.fileCount).toBe(0)
    expect(merged.totals.linesPercent).toBe(100)
  })

  test("HELL-32: totals re-aggregated across merged shards", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3), fileEntry("/b.ts", 4, 10, 0, 2))
    const r2 = reportOf(fileEntry("/a.ts", 8, 10, 2, 3), fileEntry("/c.ts", 10, 10, 5, 5))
    const merged = mergeCoverageReports([r1, r2])
    expect(merged.files).toHaveLength(3)
    expect(merged.totals.fileCount).toBe(3)
    // Totals are pre-computed from the merged files — must equal the
    // weighted sum, not the average-of-reports.
    let linesCov = 0
    let lineCt = 0
    for (const f of merged.files) {
      linesCov += f.linesCovered
      lineCt += f.lineCount
    }
    expect(merged.totals.linesPercent).toBe(safePercent(linesCov, lineCt))
  })

  test("HELL-33: uncoveredLines intersection — line uncovered in BOTH shards stays uncovered", () => {
    const r1 = reportOf(fileEntry("/a.ts", 5, 10, 1, 3, [3, 7, 9]))
    const r2 = reportOf(fileEntry("/a.ts", 6, 10, 1, 3, [3, 8, 9]))
    const merged = mergeCoverageReports([r1, r2])
    // Intersection of [3,7,9] and [3,8,9] = [3, 9].
    expect(merged.files[0]?.uncoveredLines).toEqual([3, 9])
  })

  test("HELL-34: stable ascending file order", () => {
    const r1 = reportOf(
      fileEntry("/z.ts", 1, 2, 0, 1),
      fileEntry("/a.ts", 1, 2, 0, 1),
      fileEntry("/m.ts", 1, 2, 0, 1),
    )
    const merged = mergeCoverageReports([r1])
    const paths = merged.files.map((f) => f.file)
    expect(paths).toEqual(["/a.ts", "/m.ts", "/z.ts"])
  })
})

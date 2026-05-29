/**
 * Coverage report merge (ADR-0173 — Phase 3 of ADR-0165/0170).
 *
 * Sum HIT COUNTS per `(file, branchId/statementId)` across parallel processes
 * — for instance N test shards each produce one V8 JSON; the caller reduces
 * with `mergeCoverageReports([r1, r2, r3])` before threshold gating.
 *
 * Drift policy: when the same file appears in two reports but with a
 * different `branchCount` / `statementCount` / `lineCount`, the AST shape
 * has SHIFTED between report generations (source edit between shard runs).
 * We THROW a `CoverageError("json-malformed", ...)` — silently merging
 * mismatched shapes would alias different branches under the same ID.
 * Callers MUST re-generate the per-shard report after each source change.
 *
 * Empty input: `mergeCoverageReports([])` returns the empty report
 * `{ files: [], totals: {0,0,0,0}, generatedAt: now() }` — the identity
 * element for the merge operation.
 *
 * Plane-clean: this module imports ONLY the in-slice port (no `node:fs`,
 * no `typescript`). The merge is pure shape arithmetic.
 */

import { CoverageError, type CoverageReport, type FileCoverage } from "./port"

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

/**
 * Merge `a` + `b` for a single file.
 *
 * Shape invariants `a` and `b` MUST agree on: `lineCount`, `branchCount`,
 * `statementCount`. Any disagreement → throw (drift detect).
 *
 * Coverage NUMERATORS use the MAX (a branch covered in EITHER shard is
 * covered in the merged report) — this is the standard Istanbul reduce
 * (NOT sum, because the `linesCovered` value is a count of LINES marked
 * covered, NOT total executions; summing would over-count when both shards
 * hit the same line).
 *
 * `uncoveredLines` = intersection (a line is uncovered ONLY when BOTH shards
 * missed it).
 */
const mergeFileCoverage = (a: FileCoverage, b: FileCoverage): FileCoverage => {
  if (a.lineCount !== b.lineCount) {
    throw new CoverageError(
      "json-malformed",
      `coverage merge: line-count drift for ${a.file}: ${a.lineCount} vs ${b.lineCount}`,
    )
  }
  if (a.branchCount !== b.branchCount) {
    throw new CoverageError(
      "json-malformed",
      `coverage merge: branch-count drift for ${a.file}: ${a.branchCount} vs ${b.branchCount}`,
    )
  }
  if (a.statementCount !== b.statementCount) {
    throw new CoverageError(
      "json-malformed",
      `coverage merge: statement-count drift for ${a.file}: ${a.statementCount} vs ${b.statementCount}`,
    )
  }
  const uncoveredA = new Set(a.uncoveredLines)
  const uncoveredB = new Set(b.uncoveredLines)
  const uncoveredMerged: number[] = []
  for (const ln of uncoveredA) {
    if (uncoveredB.has(ln)) uncoveredMerged.push(ln)
  }
  uncoveredMerged.sort((x, y) => x - y)
  // Coverage merge: a line/branch/statement is covered if EITHER shard
  // covered it. We don't have per-line hit counts in the port — we only have
  // covered-count totals. Conservative: take the MAX (the shard that covered
  // more wins). Combined with the uncoveredLines intersection, this is the
  // closest port-faithful "OR" available.
  const linesCovered = Math.max(
    a.linesCovered,
    b.linesCovered,
    a.lineCount - uncoveredMerged.length,
  )
  const linesCoveredClamped = Math.min(linesCovered, a.lineCount)
  const branchesCovered = Math.max(a.branchesCovered, b.branchesCovered)
  const statementsCovered = Math.max(a.statementsCovered, b.statementsCovered, linesCoveredClamped)
  const statementsCoveredClamped = Math.min(statementsCovered, a.statementCount)
  return {
    file: a.file,
    lineCount: a.lineCount,
    linesCovered: linesCoveredClamped,
    linesPercent: safePercent(linesCoveredClamped, a.lineCount),
    branchCount: a.branchCount,
    branchesCovered,
    branchesPercent: safePercent(branchesCovered, a.branchCount),
    statementCount: a.statementCount,
    statementsCovered: statementsCoveredClamped,
    statementsPercent: safePercent(statementsCoveredClamped, a.statementCount),
    uncoveredLines: uncoveredMerged,
  }
}

const computeTotals = (files: ReadonlyArray<FileCoverage>): CoverageReport["totals"] => {
  let lineCount = 0
  let linesCovered = 0
  let branchCount = 0
  let branchesCovered = 0
  let statementCount = 0
  let statementsCovered = 0
  for (const f of files) {
    lineCount += f.lineCount
    linesCovered += f.linesCovered
    branchCount += f.branchCount
    branchesCovered += f.branchesCovered
    statementCount += f.statementCount
    statementsCovered += f.statementsCovered
  }
  return {
    linesPercent: safePercent(linesCovered, lineCount),
    branchesPercent: safePercent(branchesCovered, branchCount),
    statementsPercent: safePercent(statementsCovered, statementCount),
    fileCount: files.length,
  }
}

/**
 * Reduce N reports into one by file-path + max-numerator semantics. See
 * module docstring for the shape-drift policy.
 */
export const mergeCoverageReports = (reports: ReadonlyArray<CoverageReport>): CoverageReport => {
  if (reports.length === 0) {
    return {
      files: [],
      totals: { linesPercent: 100, branchesPercent: 100, statementsPercent: 100, fileCount: 0 },
      generatedAt: Date.now(),
    }
  }
  const byPath = new Map<string, FileCoverage>()
  for (const r of reports) {
    for (const f of r.files) {
      const prior = byPath.get(f.file)
      if (prior === undefined) {
        byPath.set(f.file, f)
      } else {
        byPath.set(f.file, mergeFileCoverage(prior, f))
      }
    }
  }
  const files = Array.from(byPath.values())
  // Deterministic order: ascending by abs path. The downstream emitter keys
  // by path anyway, but a stable array order helps snapshot tests.
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return {
    files,
    totals: computeTotals(files),
    generatedAt: Date.now(),
  }
}

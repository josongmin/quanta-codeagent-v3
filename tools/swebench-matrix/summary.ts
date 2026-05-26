/**
 * `--summary` post-processor for `tools/swebench-matrix.ts`.
 *
 * Reads `<outDir>/matrix-summary.jsonl` (legacy mode) or
 * `<outDir>/matrix-summary-axes.jsonl` (axes mode) and produces extended
 * stats beyond the markdown table the runner already writes:
 *   - per-condition pass@1, σ (stddev of pass{0,1} draws), n
 *   - cost vs pass@1 scatter rows (one per condition)
 *   - ROI proxy = passAt1Pct / avgCostUsd (when avgCostUsd > 0)
 *
 * Pure of side effects: takes `MatrixRow[]` in, returns `SummaryReport`.
 * The runner / standalone CLI is the writer.
 *
 * Why a separate module: a long sweep produces a JSONL the operator wants
 * to re-analyse without re-running the bench. This file lets the operator
 * point `--summary --out runs/foo` at any historical sweep and get the
 * extended view without the source of truth changing.
 */
import { readFileSync } from "node:fs"
import type { MatrixRow } from "../swebench-matrix"

/** Per-condition extended row. The `condition` field is the raw label —
 *  the runner aggregator uses the canonical `Condition` enum, this view
 *  is condition-string-keyed so axes-mode labels (e.g. `axes-lsp_subagent`)
 *  fit through unchanged. */
export interface SummaryRow {
  readonly condition: string
  readonly n: number
  readonly passed: number
  /** pass@1 in [0, 100] (percent). Mirrors the markdown table's number. */
  readonly passAt1Pct: number
  /** σ (population standard deviation) of the per-pick pass indicator —
   *  i.e. √(p·(1-p)) for Bernoulli draws. Reported in [0, 0.5]. */
  readonly passStddev: number
  readonly avgCostUsd: number
  readonly totalCostUsd: number
  readonly avgWallMs: number
  /** ROI proxy = passAt1Pct / avgCostUsd (per-percent cost). 0 when the
   *  average cost is 0 (no model used, or unknown model). */
  readonly roiPerUsd: number
}

/** Scatter row for cost-vs-pass plots. One per condition. */
export interface ScatterRow {
  readonly condition: string
  readonly avgCostUsd: number
  readonly passAt1Pct: number
  readonly n: number
}

export interface SummaryReport {
  readonly rows: readonly SummaryRow[]
  readonly scatter: readonly ScatterRow[]
  readonly totalCostUsd: number
  readonly totalRows: number
}

/** Group rows by condition string. `degraded` rows are excluded from the
 *  denominator (matches the runner's `aggregate` semantics). `error` rows
 *  are kept (fail-to-deliver). */
const groupByCondition = (rows: readonly MatrixRow[]): Map<string, MatrixRow[]> => {
  const m = new Map<string, MatrixRow[]>()
  for (const r of rows) {
    const list = m.get(r.condition) ?? []
    list.push(r)
    m.set(r.condition, list)
  }
  return m
}

const stddevBernoulli = (passed: number, total: number): number => {
  if (total === 0) return 0
  const p = passed / total
  return Math.sqrt(p * (1 - p))
}

const round = (n: number, dp: number): number => {
  const k = 10 ** dp
  return Math.round(n * k) / k
}

const meanBy = (rows: readonly MatrixRow[], sel: (r: MatrixRow) => number): number => {
  if (rows.length === 0) return 0
  let s = 0
  for (const r of rows) s += sel(r)
  return s / rows.length
}

/** Build the extended summary report from `MatrixRow[]`. Pure. */
export const buildSummary = (allRows: readonly MatrixRow[]): SummaryReport => {
  const grouped = groupByCondition(allRows)
  const rows: SummaryRow[] = []
  let totalCostUsd = 0
  for (const [condition, list] of grouped) {
    const counted = list.filter((r) => r.verdict !== "degraded")
    const passed = counted.filter((r) => r.verdict === "pass").length
    const n = counted.length
    const passAt1Pct = n === 0 ? 0 : round((passed / n) * 100, 1)
    const passStddev = round(stddevBernoulli(passed, n), 4)
    const avgCostUsd = round(
      meanBy(counted, (r) => r.costUsd),
      4,
    )
    const totalRowCost = counted.reduce((acc, r) => acc + r.costUsd, 0)
    totalCostUsd += totalRowCost
    const avgWallMs = Math.round(meanBy(counted, (r) => r.wallMs))
    const roiPerUsd = avgCostUsd === 0 ? 0 : round(passAt1Pct / avgCostUsd, 2)
    rows.push({
      condition,
      n,
      passed,
      passAt1Pct,
      passStddev,
      avgCostUsd,
      totalCostUsd: round(totalRowCost, 4),
      avgWallMs,
      roiPerUsd,
    })
  }
  // Sort by pass@1 descending, ties broken by lower cost (Pareto-friendly).
  rows.sort((a, b) => {
    if (a.passAt1Pct !== b.passAt1Pct) return b.passAt1Pct - a.passAt1Pct
    return a.avgCostUsd - b.avgCostUsd
  })
  const scatter: ScatterRow[] = rows.map((r) => ({
    condition: r.condition,
    avgCostUsd: r.avgCostUsd,
    passAt1Pct: r.passAt1Pct,
    n: r.n,
  }))
  return {
    rows,
    scatter,
    totalCostUsd: round(totalCostUsd, 4),
    totalRows: allRows.length,
  }
}

/** Load matrix-summary.jsonl rows. Throws on file-read error. Skips
 *  malformed lines (matches the runner's forgiving parser). */
export const readSummaryRows = (file: string): readonly MatrixRow[] => {
  const text = readFileSync(file, "utf8")
  const out: MatrixRow[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    try {
      const obj = JSON.parse(line) as MatrixRow
      if (typeof obj.condition === "string" && typeof obj.pickId === "string") {
        out.push(obj)
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return out
}

/** Render the summary report as a markdown table. */
export const formatSummaryTable = (report: SummaryReport): string => {
  const header = "| condition | n | pass@1 | σ | avg $ | total $ | avg wall (s) | ROI (%/$) |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |"
  const lines = report.rows.map((r) => {
    const wallS = (r.avgWallMs / 1000).toFixed(1)
    return (
      `| ${r.condition} | ${r.n} | ${r.passAt1Pct.toFixed(1)}% (${r.passed}/${r.n}) | ` +
      `${r.passStddev.toFixed(4)} | $${r.avgCostUsd.toFixed(4)} | $${r.totalCostUsd.toFixed(4)} | ` +
      `${wallS} | ${r.roiPerUsd.toFixed(2)} |`
    )
  })
  const totals = `\n_total cost: $${report.totalCostUsd.toFixed(4)} across ${report.totalRows} row(s)_`
  return [header, sep, ...lines].join("\n") + totals
}

/**
 * Render a `CoverageMatrix` to markdown. Output is small, monospace-friendly,
 * and drops into a PR comment unchanged. One section per major.
 */
import type { Verdict } from "../types"
import type { CoverageMatrix } from "./coverage-matrix"

const SYMBOL: Record<Verdict, string> = {
  pass: "OK",
  partial: "PARTIAL",
  fail: "FAIL",
  error: "ERR",
  skipped: "TBD",
}

const fmtCell = (verdict: Verdict, count: number): string =>
  count === 0 ? "TBD" : count === 1 ? SYMBOL[verdict] : `${SYMBOL[verdict]}(${count})`

export const renderMatrixMarkdown = (m: CoverageMatrix): string => {
  const lines: string[] = []
  lines.push("# Eval Coverage Matrix")
  lines.push("")
  lines.push(`Records seen: ${m.recordsSeen}`)
  lines.push("")
  for (const block of m.blocks) {
    const share = block.share !== undefined ? ` (${Math.round(block.share * 100)}%)` : ""
    lines.push(`## ${block.label}${share}`)
    lines.push("")
    const header = ["UseCase", "중분류", ...m.tiers]
    lines.push(`| ${header.join(" | ")} |`)
    lines.push(`|${header.map(() => "---").join("|")}|`)
    for (const row of block.rows) {
      const cells = m.tiers.map((t) => fmtCell(row.cells[t].verdict, row.cells[t].count))
      lines.push(`| \`${row.id}\` | ${row.midLabel} | ${cells.join(" | ")} |`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

/** One-line top summary: counts per tier across all use cases. */
export const renderHeadline = (m: CoverageMatrix): string => {
  const tally: Record<Verdict, number> = {
    pass: 0,
    partial: 0,
    fail: 0,
    error: 0,
    skipped: 0,
  }
  for (const block of m.blocks) {
    for (const row of block.rows) {
      for (const t of m.tiers) {
        if (row.cells[t].count > 0) tally[row.cells[t].verdict] += 1
      }
    }
  }
  return `OK=${tally.pass} PARTIAL=${tally.partial} FAIL=${tally.fail} ERR=${tally.error} TBD=${tally.skipped}`
}

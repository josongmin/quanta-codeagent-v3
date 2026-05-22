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
  // ADR-0087 — Token & Cost summary. Rendered ONLY when the matrix carried a
  // rollup (i.e. at least one payload reported usage); a usage-free corpus emits
  // no extra lines, keeping the report byte-identical to the pre-feature path.
  if (m.tokenCost !== undefined) {
    const tc = m.tokenCost
    lines.push("## Token & Cost Summary")
    lines.push("")
    lines.push(`Runs with usage: ${tc.records}`)
    lines.push(`Prompt tokens: ${tc.prompt}`)
    lines.push(`Completion tokens: ${tc.completion}`)
    if (tc.cacheRead > 0) lines.push(`Cache-read tokens: ${tc.cacheRead}`)
    lines.push(`Estimated cost: $${tc.costUsd.toFixed(4)}`)
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
  const base = `OK=${tally.pass} PARTIAL=${tally.partial} FAIL=${tally.fail} ERR=${tally.error} TBD=${tally.skipped}`
  // ADR-0087 — append token/cost only when present (byte-identical otherwise).
  if (m.tokenCost === undefined) return base
  const totalTokens = m.tokenCost.prompt + m.tokenCost.completion + m.tokenCost.cacheRead
  return `${base} Tokens=${totalTokens} Cost=$${m.tokenCost.costUsd.toFixed(4)}`
}

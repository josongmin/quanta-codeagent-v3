/**
 * Fork-branch report formatter (PURE).
 *
 * After running K experiment branches (trajectory forks) over a single bench
 * instance, render a compact monospace-aligned comparison table so a human can
 * see at a glance WHICH branch resolved the instance and HOW the patches differ.
 *
 * This module is intentionally pure: no I/O, no Date.now, no Math.random. The
 * same input always yields byte-identical output, which is what makes it safe to
 * snapshot in tests and to diff across runs.
 */

export interface ForkBranchOutcome {
  readonly name: string // experiment name (e.g. "baseline", "inject")
  readonly passed: boolean // did this branch resolve the instance
  readonly patchBytes: number // size of the generated patch (0 = empty/no patch)
  readonly turns?: number // agent turns used (optional)
  readonly reason?: string // short failure/verdict reason (optional, may be multi-word)
}

/** Sentinel emitted when there are no branches to report. */
export const NO_BRANCHES = "(no branches)"

/** Max reason width before truncation; the ellipsis eats into this budget. */
const REASON_MAX = 60
const ELLIPSIS = "…"

/** Fixed column set, in render order. */
const HEADERS = ["BRANCH", "RESOLVED", "PATCH(bytes)", "TURNS", "REASON"] as const

const RESOLVED_YES = "yes"
const RESOLVED_NO = "no"

const truncateReason = (reason: string): string => {
  if (reason.length <= REASON_MAX) return reason
  // Reserve one slot for the ellipsis so the result is exactly REASON_MAX wide.
  return reason.slice(0, REASON_MAX - ELLIPSIS.length) + ELLIPSIS
}

const cellsFor = (b: ForkBranchOutcome): readonly string[] => [
  b.name,
  b.passed ? RESOLVED_YES : RESOLVED_NO,
  String(b.patchBytes),
  b.turns === undefined ? "-" : String(b.turns),
  b.reason === undefined ? "" : truncateReason(b.reason),
]

const padRight = (s: string, width: number): string =>
  s.length >= width ? s : s + " ".repeat(width - s.length)

/**
 * Render a deterministic, monospace-aligned table. Header row, one row per
 * branch IN INPUT ORDER, then a trailing summary line:
 *   "{p}/{n} branches resolved"  (+ " — DIVERGED" when outcomes differ).
 */
export const formatForkBranchReport = (
  instanceId: string,
  branches: readonly ForkBranchOutcome[],
): string => {
  if (branches.length === 0) {
    return `${instanceId}\n${NO_BRANCHES}`
  }

  const rows: readonly (readonly string[])[] = [HEADERS, ...branches.map(cellsFor)]

  // Column widths = widest cell per column across header + every data row.
  const widths = HEADERS.map((_, col) =>
    rows.reduce((max, row) => Math.max(max, (row[col] ?? "").length), 0),
  )

  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, col) => padRight(cell, widths[col] ?? 0))
      .join("  ")
      .trimEnd()

  const passed = branches.filter((b) => b.passed).length
  const total = branches.length
  // DIVERGED iff the branches did not all agree on the outcome.
  const diverged = passed !== 0 && passed !== total
  const summary = `${passed}/${total} branches resolved${diverged ? " — DIVERGED" : ""}`

  const lines = [instanceId, ...rows.map(renderRow), summary]
  return lines.join("\n")
}

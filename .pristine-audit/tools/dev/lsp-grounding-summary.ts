/**
 * LSP-03 measurement aggregator (jun-23 LSP stability proof).
 *
 * Reads a bench `report.json`, pulls every per-instance typed LSP-grounding
 * status (`result.lspGrounding`, emitted by the strict gate — LSP-02), folds
 * them with the SSOT `summarizeGroundingStatuses`, and prints the measurement
 * table the promotion gate requires. This is the LAST mile of LSP-03: once any
 * grounding-preset bench run (local or EC2 full-remote) lands a report.json,
 * this turns it into the ready-duration / outcome-count distribution that a
 * budget/anchor change must be justified against — no n=1 timeout twiddle.
 *
 *   bun run tools/dev/lsp-grounding-summary.ts <path/to/report.json> [more.json ...]
 *
 * Multiple report paths are merged (repeated runs → one distribution), exactly
 * the n>1 the protocol mandates.
 */
import { readFileSync } from "node:fs"
import {
  type LspGroundingStatus,
  type LspGroundingSummary,
  summarizeGroundingStatuses,
} from "@/shared"

/** Pull the typed grounding statuses out of a parsed report.json (or several).
 *  Tolerant of shape drift: anything without a `results` array, or a result
 *  without `lspGrounding`, is skipped — never throws on a malformed row. */
export const extractGroundingStatuses = (reports: readonly unknown[]): LspGroundingStatus[] => {
  const out: LspGroundingStatus[] = []
  for (const report of reports) {
    const results = (report as { results?: unknown })?.results
    if (!Array.isArray(results)) continue
    for (const r of results) {
      const status = (r as { lspGrounding?: unknown })?.lspGrounding
      if (status !== undefined && status !== null && typeof status === "object") {
        out.push(status as LspGroundingStatus)
      }
    }
  }
  return out
}

const median = (sorted: readonly number[]): number | undefined => {
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  const a = sorted[mid]
  if (sorted.length % 2 === 1) return a
  const b = sorted[mid - 1]
  return a !== undefined && b !== undefined ? Math.round((a + b) / 2) : a
}

const histogram = (m: Readonly<Partial<Record<string, number>>>): string => {
  const entries = Object.entries(m).sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? "(none)" : entries.map(([k, v]) => `${k}=${v}`).join(" ")
}

/** Render a {@link LspGroundingSummary} as the protocol's measurement table —
 *  PURE (no clock/IO) so it is unit-testable against a fixture. */
export const renderGroundingMeasurement = (summary: LspGroundingSummary): string => {
  const d = summary.readyDurationsMs
  const min = d[0]
  const max = d[d.length - 1]
  const med = median(d)
  const msCell = d.length === 0 ? "n/a" : `${min}/${med}/${max}`
  return [
    `LSP grounding measurement (LSP-03)`,
    `  grounding rows:    ${summary.total}`,
    `  launch outcomes:   ${histogram(summary.launchOutcomes)}`,
    `  ready outcomes:    ${histogram(summary.readyOutcomes)}`,
    `  ready_timeout:     ${summary.readyTimeouts}`,
    `  expected_cancel:   ${summary.expectedCancels}`,
    `  fatal_transport:   ${summary.fatalTransports}`,
    `  ready ms (min/med/max over ${d.length}): ${msCell}`,
  ].join("\n")
}

const main = (): void => {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    process.stderr.write(
      "usage: bun run tools/dev/lsp-grounding-summary.ts <report.json> [report.json ...]\n",
    )
    process.exit(2)
  }
  const reports = paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as unknown)
  const statuses = extractGroundingStatuses(reports)
  const summary = summarizeGroundingStatuses(statuses)
  process.stdout.write(`${renderGroundingMeasurement(summary)}\n`)
  if (summary.total === 0) {
    process.stderr.write(
      "\n[note] 0 grounding rows — was this a grounding-required preset (e.g. agentless-v3-thin-strict)? " +
        "Only those presets emit result.lspGrounding.\n",
    )
  }
}

if (import.meta.main) main()

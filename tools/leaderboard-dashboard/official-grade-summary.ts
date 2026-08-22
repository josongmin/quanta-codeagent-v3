#!/usr/bin/env bun
/**
 * PMX-05 — the operator's official-grade summary for ONE persisted bench report.
 *
 *   bun run tools/leaderboard-dashboard/official-grade-summary.ts <report.json>
 *   bun run tools/leaderboard-dashboard/official-grade-summary.ts <report.json> --markdown
 *
 * The definition of done for PMX-05 is that an operator can read score, coverage,
 * invalid reasons, exact artifacts and replay inputs OFF THE REPORT — without
 * reading console logs and without trusting the upstream printed denominator.
 * This is that surface.
 *
 * It computes NOTHING. The report already carries the one aggregation's result;
 * this reads it through the dashboard's single decode boundary
 * (`decodeReportArtifact`, which re-validates the covering partition on the way
 * in) and hands it to the report layer's one formatter. So the CLI text, the
 * markdown export and the dashboard cards are the same numbers by construction
 * rather than by three copies of a rounding rule.
 */
import { readFileSync } from "node:fs"
import {
  renderOfficialGradeCliLines,
  renderOfficialGradeMarkdown,
} from "@/runner/batch/report-official-grade"
import { decodeReportArtifact } from "./projectors/registry"

export class NoOfficialGradeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoOfficialGradeError"
  }
}

export interface OfficialGradeSummaryOpts {
  readonly markdown?: boolean
}

/**
 * Render one persisted artifact's official-grade summary. Fails closed: a report
 * of the wrong suite, or one that never ran an official grader, is refused rather
 * than summarized as an empty campaign (which would read as "0 assigned" and is
 * indistinguishable from a real total wipeout).
 */
export const renderOfficialGradeSummary = (
  raw: unknown,
  opts: OfficialGradeSummaryOpts = {},
): string => {
  const report = decodeReportArtifact(raw)
  if (report.benchmarkSuite !== "swe-bench") {
    throw new NoOfficialGradeError(
      `official-grade totals live on the swe-bench branch; this artifact is ${report.benchmarkSuite}`,
    )
  }
  const section = report.officialGrade
  if (section === undefined) {
    throw new NoOfficialGradeError(
      "this report carries no officialGrade section — the run never invoked an official grader",
    )
  }
  return opts.markdown === true
    ? renderOfficialGradeMarkdown(section)
    : `${renderOfficialGradeCliLines(section).join("\n")}\n`
}

const main = (argv: readonly string[]): number => {
  const files = argv.filter((a) => !a.startsWith("--"))
  const file = files[0]
  if (file === undefined) {
    process.stderr.write("usage: official-grade-summary.ts <report.json> [--markdown]\n")
    return 2
  }
  try {
    process.stdout.write(
      renderOfficialGradeSummary(JSON.parse(readFileSync(file, "utf8")), {
        markdown: argv.includes("--markdown"),
      }),
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))

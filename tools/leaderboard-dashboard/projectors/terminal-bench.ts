/**
 * BFND-03 — the Terminal-Bench suite projector.
 *
 * Terminal-Bench is a top-level SUITE with its own versioned, dataset-pinned
 * artifact. It has no dataset family, so nothing here reads one on the canonical
 * path; the ONE place a family string is still interpreted for Terminal is
 * {@link adoptLegacy}, which exists solely so runs recorded before BFND-02 (when
 * Terminal rode the family axis as a bogus fourth "family") keep rendering.
 *
 * The projector FORMATS the artifact's persisted official-shaped totals. It does
 * not fold trials into a score — that formula has exactly one owner
 * (`src/runner/batch/report-terminal.ts`), and the legacy adapter reaches it by
 * routing legacy trials back through that same builder.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CanonicalBenchReport,
  CanonicalReportIdentityError,
  encodeCanonicalReport,
} from "@/runner/batch/report-envelope"
import { buildTerminalBenchReport, type TerminalTrialInput } from "@/runner/batch/report-terminal"
import { parseTbPertask } from "../tb-pertask"
import { TERMINAL_BENCH_CLIENT_SCRIPT, TERMINAL_BENCH_CLIENT_STYLE } from "./terminal-bench.client"
import type { BenchmarkView, ProjectedRun, SuiteDataOpts, SuiteProjector } from "./types"

/** The view tab id AND the suite id — Terminal has exactly one view. */
const TERMINAL_VIEW_ID = "terminal-bench"

/**
 * Stand-in dataset ref for artifacts written before identity was required. It is
 * explicitly NOT a real ref: it says "this run never recorded which dataset it
 * was graded against", and it is kept out of the campaign key so pre-BFND runs
 * still group the way they always did.
 */
export const LEGACY_TB_DATASET_REF = "legacy:terminal-bench-harbor"

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asArm = (value: unknown): "baseline" | "levers" | undefined =>
  value === "baseline" || value === "levers" ? value : undefined

const asErrorKind = (value: unknown): "agent-timeout" | "agent-crash" | undefined => {
  const kind = asRecord(value)?.kind
  return kind === "agent-timeout" || kind === "agent-crash" ? kind : undefined
}

/** Legacy per-instance rows → the builder's trial inputs. */
const legacyTrials = (rows: unknown): readonly TerminalTrialInput[] => {
  if (!Array.isArray(rows)) return []
  const trials: TerminalTrialInput[] = []
  for (const row of rows) {
    const rec = asRecord(row)
    if (rec === null || typeof rec.id !== "string") continue
    const kind = asErrorKind(rec.error)
    trials.push({
      id: rec.id,
      passed: rec.passed === true,
      durationMs: Number(rec.durationMs) || 0,
      turns: Number(rec.turns) || 0,
      ...(kind !== undefined ? { error: { kind } } : {}),
    })
  }
  return trials
}

/**
 * THE legacy Terminal encoding adapter. Pre-BFND-02 artifacts carry no suite, no
 * version, no dataset ref and no totals — they identify themselves by the
 * discontinued `datasetFamily:"terminal-bench"`. Rather than teach the dashboard
 * a second reading of that field, we rebuild the artifact through the production
 * builder so the D1 metric rule is applied by its single owner.
 */
const adoptLegacy = (raw: Record<string, unknown>): Record<string, unknown> | null => {
  if (raw.benchmarkSuite !== undefined) return null
  if (raw.datasetFamily !== TERMINAL_VIEW_ID) return null
  const knobs = asRecord(raw.knobs)
  const arm = asArm(raw.arm)
  const report = buildTerminalBenchReport(legacyTrials(raw.perInstance), {
    datasetRef: LEGACY_TB_DATASET_REF,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
    model: typeof raw.model === "string" ? raw.model : undefined,
    preset: typeof knobs?.preset === "string" ? knobs.preset : "",
    ...(arm !== undefined ? { arm } : {}),
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
  })
  return encodeCanonicalReport(report)
}

/** Version + pinned dataset. Two runs of different pinned datasets are different
 *  campaigns; the legacy stand-in ref contributes nothing (it identifies nothing). */
const campaignIdentityOf = (report: { benchmarkVersion: string; datasetRef: string }): string => {
  const base = `${TERMINAL_VIEW_ID}@${report.benchmarkVersion}`
  return report.datasetRef === LEGACY_TB_DATASET_REF ? base : `${base} ${report.datasetRef}`
}

const project = (report: CanonicalBenchReport): ProjectedRun => {
  if (report.benchmarkSuite !== "terminal-bench") {
    throw new CanonicalReportIdentityError(
      `the terminal-bench projector was handed a ${report.benchmarkSuite} report`,
    )
  }
  // HIGH-A: `report` came through `decodeCanonicalReport`, which now REBUILDS the
  // Terminal branch field by field (finite totals, typed receipts) instead of
  // casting the raw JSON. The defensive `asRecord` + `Number.isFinite` re-check
  // that used to live here was a consumer compensating for an untrustworthy
  // producer; it is gone, and `registry.test.ts` proves a malformed artifact is
  // refused one layer up instead.
  const preset = report.knobs.preset.trim()
  return {
    benchmarkSuite: "terminal-bench",
    // Harbor trials: no verifier, no gold patch — a trial receipt, not a grade.
    instanceRowKind: "trial-receipt",
    viewId: TERMINAL_VIEW_ID,
    campaignIdentity: campaignIdentityOf(report),
    presetLabel: preset === "" ? TERMINAL_VIEW_ID : preset,
    headline: { resolved: report.totals.resolved, total: report.totals.total },
  }
}

const viewsFor = (seen: ReadonlySet<string>): readonly BenchmarkView[] =>
  seen.has(TERMINAL_VIEW_ID)
    ? [{ id: TERMINAL_VIEW_ID, label: "Terminal-Bench", suite: "terminal-bench" as const }]
    : []

/**
 * This suite's public per-task competitor matrix — the Terminal analogue of the
 * SWE scaffold summary. An OFFLINE, vendored file: parsed fresh per request,
 * never fetched, and completely separate from report scoring. Absent / malformed
 * ⇒ the view still shows our runs, just with no competitor column.
 */
const data = ({ rawdataDir, argOf }: SuiteDataOpts): Record<string, unknown> => {
  const path = argOf("--tb-matrix") ?? join(rawdataDir, "tb-pertask.md")
  try {
    if (!existsSync(path)) return { tb: { scaffolds: [], tasks: [] } }
    return { tb: parseTbPertask(readFileSync(path, "utf8")) }
  } catch {
    return { tb: { scaffolds: [], tasks: [] } }
  }
}

export const terminalBenchProjector: SuiteProjector = {
  suite: "terminal-bench",
  adoptLegacy,
  project,
  viewsFor,
  data,
  client: { style: TERMINAL_BENCH_CLIENT_STYLE, script: TERMINAL_BENCH_CLIENT_SCRIPT },
}

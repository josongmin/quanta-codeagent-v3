/**
 * Coverage reporter (ADR-0165).
 *
 * Composer that does TWO things on a {@link CoverageReport}:
 *   1. `evaluate` — gate the report against a {@link CoverageThreshold} and
 *      produce a closed-union {@link CoverageVerdict}. The verdict's `fail`
 *      arm carries one reason string per crossed threshold, in a stable order
 *      (lines → branches → statements) so a test asserting on `reasons[0]`
 *      stays deterministic across runs.
 *   2. `emitMetrics` — feed per-file + totals into a {@link MetricSink} (ADR-
 *      0144) as gauges. Each file produces 3 samples
 *      (`coverage.lines_percent` / `coverage.branches_percent` /
 *      `coverage.statements_percent`) with `{file}` label; totals produce 3
 *      samples with NO labels (the registry will fold them into one series
 *      each).
 *
 * Plane-clean: this module imports the in-slice port + the metrics port
 * (`MetricSink`). The metrics import is the ONLY cross-sub-slice link in
 * `@/observability/coverage/*` — both sub-modules live under the same parent
 * `@/observability` plane so the slice fence is preserved.
 *
 * Default-OFF: a reporter constructed without a sink emits no metrics — only
 * `evaluate` runs. A caller that passes a sink BUT no threshold gets metric
 * emission without any pass/fail gate. The two concerns are independently
 * opt-in.
 *
 * Sink-no-throw policy (matches ADR-0144 contract #3): if `sink.send` throws,
 * the reporter catches and silently swallows — observability MUST NOT crash
 * the caller. The ADR-0144 in-memory registry also wraps sinks in try/catch,
 * so a sink-via-registry path is doubly-protected.
 */

import type { MetricSink } from "../metrics/port"
import type { CoverageReport, CoverageThreshold, CoverageVerdict, FileCoverage } from "./port"

/** Reporter options. Both fields are independently optional. */
export interface ReporterOpts {
  readonly threshold?: CoverageThreshold
  readonly metricsSink?: MetricSink
}

export interface CoverageReporter {
  /** Gate a report against an optional threshold. Absent threshold ⇒ always
   *  `{ kind: "pass" }`. Crossed thresholds ⇒ `{ kind: "fail", reasons: […] }`
   *  with one reason per crossed dimension (lines/branches/statements). */
  evaluate(report: CoverageReport, opts?: ReporterOpts): CoverageVerdict
  /** Emit the report as metric samples to a {@link MetricSink}. Per-file
   *  gauges carry a `file` label; totals carry NO labels. Sink failures are
   *  swallowed per the no-throw contract. */
  emitMetrics(report: CoverageReport, sink: MetricSink): void
}

const buildFailReasons = (report: CoverageReport, threshold: CoverageThreshold): string[] => {
  const reasons: string[] = []
  const lt = threshold.linesPercent
  if (lt !== undefined && report.totals.linesPercent < lt) {
    reasons.push(`lines: ${report.totals.linesPercent} < ${lt}`)
  }
  const bt = threshold.branchesPercent
  if (bt !== undefined && report.totals.branchesPercent < bt) {
    reasons.push(`branches: ${report.totals.branchesPercent} < ${bt}`)
  }
  const st = threshold.statementsPercent
  if (st !== undefined && report.totals.statementsPercent < st) {
    reasons.push(`statements: ${report.totals.statementsPercent} < ${st}`)
  }
  return reasons
}

const safeSend = (
  sink: MetricSink,
  sample: {
    name: string
    value: number
    labels?: Readonly<Record<string, string>>
  },
): void => {
  try {
    sink.send({
      name: sample.name,
      kind: "gauge",
      value: sample.value,
      ...(sample.labels !== undefined ? { labels: sample.labels } : {}),
      at: Date.now(),
    })
  } catch {
    // Sink no-throw policy (ADR-0144 contract #3): swallow.
  }
}

const emitFileGauges = (sink: MetricSink, f: FileCoverage): void => {
  const labels = { file: f.file } as const
  safeSend(sink, { name: "coverage.lines_percent", value: f.linesPercent, labels })
  safeSend(sink, { name: "coverage.branches_percent", value: f.branchesPercent, labels })
  safeSend(sink, { name: "coverage.statements_percent", value: f.statementsPercent, labels })
}

class DefaultCoverageReporter implements CoverageReporter {
  evaluate(report: CoverageReport, opts?: ReporterOpts): CoverageVerdict {
    const threshold = opts?.threshold
    if (threshold === undefined) return { kind: "pass" }
    const reasons = buildFailReasons(report, threshold)
    if (reasons.length === 0) return { kind: "pass" }
    return { kind: "fail", reasons }
  }

  emitMetrics(report: CoverageReport, sink: MetricSink): void {
    for (const f of report.files) emitFileGauges(sink, f)
    safeSend(sink, { name: "coverage.total_lines_percent", value: report.totals.linesPercent })
    safeSend(sink, {
      name: "coverage.total_branches_percent",
      value: report.totals.branchesPercent,
    })
    safeSend(sink, {
      name: "coverage.total_statements_percent",
      value: report.totals.statementsPercent,
    })
  }
}

/** Construct the default coverage reporter. */
export const defaultCoverageReporter = (): CoverageReporter => new DefaultCoverageReporter()

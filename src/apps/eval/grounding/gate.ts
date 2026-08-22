/**
 * Grounding GATES — the pass/fail verdicts layered over a report.
 *
 * Split out of `report.ts`: that module answers "what did this run measure?",
 * this one answers "is that measurement good enough to ship?". Two gates live
 * here — the single-run `canary` gate and the route-MATRIX gate that requires
 * one passing run per required (mode × corpus × route) cell.
 */
import type { GroundingBucketReport, GroundingMetrics, GroundingReport } from "./report"
import type {
  GroundingRouteMatrix,
  GroundingRouteMatrixCell,
  GroundingRouteMatrixName,
} from "./route-matrix"
import { GROUNDING_ROUTE_MATRICES } from "./route-matrix"
import type { GroundingBucket, GroundingMode } from "./schema"

export const GROUNDING_GATE_PROFILES = ["canary"] as const
export type GroundingGateProfile = (typeof GROUNDING_GATE_PROFILES)[number]

export interface GroundingGateFailure {
  metric:
    | "error_count"
    | "wrong_thread_rate"
    | "clarify_recall"
    | "summary_equivalence_rate"
    | "thread_selection_accuracy"
    | "referent_accuracy"
    | "exact_tuple_match_rate"
    | "structured_output_validity"
    | "must_clarify_bucket_clarify_recall"
    | "stale_context_trap_bucket_attachment_rate"
    | "summary_equivalence_bucket_rate"
    | "wrong_thread_adversarial_bucket_wrong_thread_rate"
  expected: string
  actual: number
}

export interface GroundingGateResult {
  runId: string
  suite?: string
  corpus?: string
  mode?: GroundingMode
  profile: GroundingGateProfile
  passed: boolean
  route: GroundingReport["route"]
  counts: GroundingReport["counts"]
  failures: readonly GroundingGateFailure[]
}

export interface GroundingGateOutput {
  headline: string
  markdown: string
  result: GroundingGateResult
}

export interface GroundingRouteMatrixFailure {
  kind: "missing_cell" | "duplicate_cell" | "cell_gate_failure" | "unmatched_run"
  cellId: string
  message: string
  runIds?: readonly string[]
}

export interface GroundingRouteMatrixCellResult {
  cellId: string
  mode: GroundingMode
  corpus: string
  probeProfile?: string
  normalizationProfile?: string
  structuredOutputProtocol?: string
  route: GroundingReport["route"]
  runId?: string
  passed: boolean
  failures: readonly GroundingGateFailure[]
}

export interface GroundingRouteMatrixGateResult {
  matrix: GroundingRouteMatrixName
  profile: GroundingGateProfile
  passed: boolean
  failures: readonly GroundingRouteMatrixFailure[]
  cells: readonly GroundingRouteMatrixCellResult[]
}

export interface GroundingRouteMatrixGateOutput {
  headline: string
  markdown: string
  result: GroundingRouteMatrixGateResult
}

export const isGroundingGateProfile = (value: string): value is GroundingGateProfile =>
  GROUNDING_GATE_PROFILES.includes(value as GroundingGateProfile)

const CANARY_THRESHOLDS = {
  wrong_thread_rate: 0,
  clarify_recall: 1,
  summary_equivalence_rate: 1,
  thread_selection_accuracy: 0.97,
  referent_accuracy: 0.95,
  exact_tuple_match_rate: 0.9,
  structured_output_validity: 1,
} as const

const bucketById = (
  report: GroundingReport,
  bucket: GroundingBucket,
): GroundingBucketReport | undefined => report.buckets.find((entry) => entry.bucket === bucket)

const renderGateMarkdown = (result: GroundingGateResult): string => {
  const lines: string[] = []
  lines.push(`# Grounding Gate — ${result.runId}`)
  lines.push("")
  lines.push(`Profile: ${result.profile}`)
  lines.push(`Status: ${result.passed ? "PASS" : "FAIL"}`)
  if (result.corpus !== undefined) lines.push(`Corpus: ${result.corpus}`)
  if (result.suite !== undefined) lines.push(`Suite: ${result.suite}`)
  if (result.mode !== undefined) lines.push(`Mode: ${result.mode}`)
  const routeBits = [
    result.route.provider,
    result.route.model,
    result.route.surfaceId,
    result.route.transportId,
  ].filter((value): value is string => value !== undefined && value !== "")
  if (routeBits.length > 0) lines.push(`Route: ${routeBits.join(" / ")}`)
  if (result.route.authMode !== undefined) lines.push(`Auth: ${result.route.authMode}`)
  lines.push(
    `Verdicts: PASS=${result.counts.pass} PARTIAL=${result.counts.partial} FAIL=${result.counts.fail} ERR=${result.counts.error}`,
  )
  lines.push("")
  lines.push("## Failures")
  lines.push("")
  if (result.failures.length === 0) {
    lines.push("- none")
  } else {
    for (const failure of result.failures) {
      lines.push(`- ${failure.metric}: expected ${failure.expected}, got ${failure.actual}`)
    }
  }
  return lines.join("\n")
}

const renderRouteMatrixGateMarkdown = (result: GroundingRouteMatrixGateResult): string => {
  const lines: string[] = []
  lines.push(`# Grounding Route Matrix Gate — ${result.matrix}`)
  lines.push("")
  lines.push(`Profile: ${result.profile}`)
  lines.push(`Status: ${result.passed ? "PASS" : "FAIL"}`)
  lines.push("")
  lines.push("## Cells")
  lines.push("")
  lines.push(
    "| Cell | Run | Mode | Corpus | Probe | Normalize | Output | Status | Route | Failures |",
  )
  lines.push("|---|---|---|---|---|---|---|---|---|---|")
  for (const cell of result.cells) {
    const routeBits = [
      cell.route.provider,
      cell.route.model,
      cell.route.surfaceId,
      cell.route.transportId,
    ].filter((value): value is string => value !== undefined && value !== "")
    lines.push(
      `| ${cell.cellId} | ${cell.runId ?? "-"} | ${cell.mode} | ${cell.corpus} | ${cell.probeProfile ?? "-"} | ${cell.normalizationProfile ?? "-"} | ${cell.structuredOutputProtocol ?? "-"} | ${cell.passed ? "PASS" : "FAIL"} | ${routeBits.length > 0 ? routeBits.join(" / ") : "unknown"} | ${cell.failures.length} |`,
    )
  }
  lines.push("")
  lines.push("## Failures")
  lines.push("")
  if (result.failures.length === 0) {
    lines.push("- none")
  } else {
    for (const failure of result.failures) {
      lines.push(`- ${failure.kind}:${failure.cellId} ${failure.message}`)
    }
  }
  return lines.join("\n")
}

const matchesMatrixCell = (report: GroundingReport, cell: GroundingRouteMatrixCell): boolean =>
  report.mode === cell.mode &&
  report.corpus === cell.corpus &&
  (cell.provider === undefined || report.route.provider === cell.provider) &&
  (cell.model === undefined || report.route.model === cell.model) &&
  (cell.surfaceId === undefined || report.route.surfaceId === cell.surfaceId) &&
  (cell.transportId === undefined || report.route.transportId === cell.transportId) &&
  (cell.authMode === undefined || report.route.authMode === cell.authMode) &&
  (cell.probeProfile === undefined || report.probeProfile === cell.probeProfile) &&
  (cell.normalizationProfile === undefined ||
    report.normalizationProfile === cell.normalizationProfile) &&
  (cell.structuredOutputProtocol === undefined ||
    report.structuredOutputProtocol === cell.structuredOutputProtocol)

// ── canary gate ──────────────────────────────────────────────────────────────

/** A suite-wide metric threshold: `exact` demands equality with the threshold,
 *  `atLeast` demands the metric not fall below it. */
interface CanaryMetricGate {
  readonly metric: keyof GroundingMetrics
  readonly failure: GroundingGateFailure["metric"]
  readonly compare: "exact" | "atLeast"
  readonly threshold: number
  readonly expected: string
}

const CANARY_METRIC_GATES: readonly CanaryMetricGate[] = [
  {
    metric: "wrong_thread_rate",
    failure: "wrong_thread_rate",
    compare: "exact",
    threshold: CANARY_THRESHOLDS.wrong_thread_rate,
    expected: "== 0",
  },
  {
    metric: "clarify_recall",
    failure: "clarify_recall",
    compare: "exact",
    threshold: CANARY_THRESHOLDS.clarify_recall,
    expected: "== 1.0",
  },
  {
    metric: "summary_equivalence_rate",
    failure: "summary_equivalence_rate",
    compare: "exact",
    threshold: CANARY_THRESHOLDS.summary_equivalence_rate,
    expected: "== 1.0",
  },
  {
    metric: "thread_selection_accuracy",
    failure: "thread_selection_accuracy",
    compare: "atLeast",
    threshold: CANARY_THRESHOLDS.thread_selection_accuracy,
    expected: ">= 0.97",
  },
  {
    metric: "referent_accuracy",
    failure: "referent_accuracy",
    compare: "atLeast",
    threshold: CANARY_THRESHOLDS.referent_accuracy,
    expected: ">= 0.95",
  },
  {
    metric: "exact_tuple_match_rate",
    failure: "exact_tuple_match_rate",
    compare: "atLeast",
    threshold: CANARY_THRESHOLDS.exact_tuple_match_rate,
    expected: ">= 0.90",
  },
  {
    metric: "structured_output_validity",
    failure: "structured_output_validity",
    compare: "exact",
    threshold: CANARY_THRESHOLDS.structured_output_validity,
    expected: "== 1.0",
  },
]

const violatesGate = (actual: number, gate: CanaryMetricGate): boolean =>
  gate.compare === "exact" ? actual !== gate.threshold : actual < gate.threshold

const canaryMetricFailures = (report: GroundingReport): readonly GroundingGateFailure[] => {
  const failures: GroundingGateFailure[] = []
  for (const gate of CANARY_METRIC_GATES) {
    const actual = report.metrics[gate.metric]
    if (!violatesGate(actual, gate)) continue
    failures.push({ metric: gate.failure, expected: gate.expected, actual })
  }
  return failures
}

/** A bucket whose CRITICAL cases must hold their own signature metric — checked
 *  only when the bucket exists in the report AND actually carries critical
 *  cases (an absent or non-critical bucket is not evidence of a regression). */
interface CriticalBucketGate {
  readonly bucket: GroundingBucket
  readonly metric: keyof GroundingMetrics
  readonly failure: GroundingGateFailure["metric"]
  readonly threshold: number
  readonly expected: string
}

const CRITICAL_BUCKET_GATES: readonly CriticalBucketGate[] = [
  {
    bucket: "must_clarify",
    metric: "clarify_recall",
    failure: "must_clarify_bucket_clarify_recall",
    threshold: 1,
    expected: "== 1.0",
  },
  {
    bucket: "stale_context_trap",
    metric: "stale_context_attachment_rate",
    failure: "stale_context_trap_bucket_attachment_rate",
    threshold: 0,
    expected: "== 0",
  },
  {
    bucket: "summary_equivalence",
    metric: "summary_equivalence_rate",
    failure: "summary_equivalence_bucket_rate",
    threshold: 1,
    expected: "== 1.0",
  },
  {
    bucket: "wrong_thread_adversarial",
    metric: "wrong_thread_rate",
    failure: "wrong_thread_adversarial_bucket_wrong_thread_rate",
    threshold: 0,
    expected: "== 0",
  },
]

const criticalBucketFailures = (report: GroundingReport): readonly GroundingGateFailure[] => {
  const failures: GroundingGateFailure[] = []
  for (const gate of CRITICAL_BUCKET_GATES) {
    const bucket = bucketById(report, gate.bucket)
    if (bucket === undefined || bucket.criticalCases === 0) continue
    const actual = bucket.metrics[gate.metric]
    if (actual === gate.threshold) continue
    failures.push({ metric: gate.failure, expected: gate.expected, actual })
  }
  return failures
}

export const evaluateGroundingGate = (
  report: GroundingReport,
  profile: GroundingGateProfile,
): readonly GroundingGateFailure[] => {
  // `assisted` mode is a human-in-the-loop run; its metrics are not a gate.
  if (report.mode === "assisted") return []
  switch (profile) {
    case "canary":
      return [
        ...(report.counts.error > 0
          ? [
              {
                metric: "error_count" as const,
                expected: "== 0",
                actual: report.counts.error,
              },
            ]
          : []),
        ...canaryMetricFailures(report),
        ...criticalBucketFailures(report),
      ]
  }
}

export const buildGroundingGateResult = (
  report: GroundingReport,
  profile: GroundingGateProfile,
): GroundingGateOutput => {
  const failures = evaluateGroundingGate(report, profile)
  const result: GroundingGateResult = {
    runId: report.runId,
    ...(report.suite !== undefined ? { suite: report.suite } : {}),
    ...(report.corpus !== undefined ? { corpus: report.corpus } : {}),
    ...(report.mode !== undefined ? { mode: report.mode } : {}),
    profile,
    passed: failures.length === 0,
    route: report.route,
    counts: report.counts,
    failures,
  }
  return {
    headline: `${result.passed ? "grounding gate passed" : "grounding gate failed"}: profile=${profile} runId=${report.runId}`,
    markdown: renderGateMarkdown(result),
    result,
  }
}

// ── route matrix gate ────────────────────────────────────────────────────────

/** The cell's own coordinates, echoed onto every result row it produces. */
const cellIdentity = (
  cell: GroundingRouteMatrixCell,
): Pick<
  GroundingRouteMatrixCellResult,
  | "cellId"
  | "mode"
  | "corpus"
  | "probeProfile"
  | "normalizationProfile"
  | "structuredOutputProtocol"
> => ({
  cellId: cell.id,
  mode: cell.mode,
  corpus: cell.corpus,
  ...(cell.probeProfile !== undefined ? { probeProfile: cell.probeProfile } : {}),
  ...(cell.normalizationProfile !== undefined
    ? { normalizationProfile: cell.normalizationProfile }
    : {}),
  ...(cell.structuredOutputProtocol !== undefined
    ? { structuredOutputProtocol: cell.structuredOutputProtocol }
    : {}),
})

/** With no run to read a route from, the cell's own spec IS the route. */
const cellSpecRoute = (cell: GroundingRouteMatrixCell): GroundingReport["route"] => ({
  ...(cell.provider !== undefined ? { provider: cell.provider } : {}),
  ...(cell.model !== undefined ? { model: cell.model } : {}),
  ...(cell.surfaceId !== undefined ? { surfaceId: cell.surfaceId } : {}),
  ...(cell.transportId !== undefined ? { transportId: cell.transportId } : {}),
  ...(cell.authMode !== undefined ? { authMode: cell.authMode } : {}),
})

interface MatrixCellOutcome {
  readonly failures: readonly GroundingRouteMatrixFailure[]
  readonly cell: GroundingRouteMatrixCellResult
}

/**
 * One matrix cell's verdict. Three shapes, and only the third one actually runs
 * the canary gate:
 *   - no run matched   → `missing_cell`, cell recorded from the spec alone
 *   - >1 run matched   → `duplicate_cell`, ambiguous so it cannot pass
 *   - exactly one run  → the cell passes iff that run passes the gate
 */
const evaluateMatrixCell = (
  cell: GroundingRouteMatrixCell,
  reports: readonly GroundingReport[],
  profile: GroundingGateProfile,
): MatrixCellOutcome => {
  const matches = reports.filter((report) => matchesMatrixCell(report, cell))
  if (matches.length === 0) {
    return {
      failures: [
        {
          kind: "missing_cell",
          cellId: cell.id,
          message: "no run matched required matrix cell",
        },
      ],
      cell: { ...cellIdentity(cell), route: cellSpecRoute(cell), passed: false, failures: [] },
    }
  }
  const primary = matches[0] as GroundingReport
  if (matches.length > 1) {
    return {
      failures: [
        {
          kind: "duplicate_cell",
          cellId: cell.id,
          message: "multiple runs matched one required matrix cell",
          runIds: matches.map((report) => report.runId),
        },
      ],
      cell: {
        ...cellIdentity(cell),
        route: primary.route,
        runId: primary.runId,
        passed: false,
        failures: [],
      },
    }
  }
  const gate = buildGroundingGateResult(primary, profile)
  return {
    failures:
      gate.result.failures.length > 0
        ? [
            {
              kind: "cell_gate_failure",
              cellId: cell.id,
              message: `run ${primary.runId} failed ${profile} gate`,
              runIds: [primary.runId],
            },
          ]
        : [],
    cell: {
      ...cellIdentity(cell),
      route: primary.route,
      runId: primary.runId,
      passed: gate.result.failures.length === 0,
      failures: gate.result.failures,
    },
  }
}

/** A run that answers no required cell is unaccounted-for evidence. */
const unmatchedRunFailures = (
  reports: readonly GroundingReport[],
  matrix: GroundingRouteMatrix,
): readonly GroundingRouteMatrixFailure[] =>
  reports
    .filter((report) => !matrix.cells.some((cell) => matchesMatrixCell(report, cell)))
    .map((report) => ({
      kind: "unmatched_run" as const,
      cellId: report.runId,
      message: "provided run did not match any required matrix cell",
      runIds: [report.runId],
    }))

export const buildGroundingRouteMatrixGateResult = (
  reports: readonly GroundingReport[],
  matrixName: GroundingRouteMatrixName,
  profile: GroundingGateProfile,
): GroundingRouteMatrixGateOutput => {
  const matrix: GroundingRouteMatrix = GROUNDING_ROUTE_MATRICES[matrixName]
  const outcomes = matrix.cells.map((cell) => evaluateMatrixCell(cell, reports, profile))
  const failures: readonly GroundingRouteMatrixFailure[] = [
    ...outcomes.flatMap((outcome) => outcome.failures),
    ...unmatchedRunFailures(reports, matrix),
  ]
  const cells = outcomes.map((outcome) => outcome.cell)
  const result: GroundingRouteMatrixGateResult = {
    matrix: matrixName,
    profile,
    passed: failures.length === 0,
    failures,
    cells,
  }
  return {
    headline: `${result.passed ? "grounding route matrix gate passed" : "grounding route matrix gate failed"}: matrix=${matrixName} profile=${profile} cells=${cells.length}`,
    markdown: renderRouteMatrixGateMarkdown(result),
    result,
  }
}

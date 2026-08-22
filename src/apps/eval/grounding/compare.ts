import type { GroundingPayload } from "../storage"
import type { Verdict } from "../types"
import type { GroundingErrorKind } from "./diagnostics"
import type { GroundingBucketReport, GroundingMetrics, GroundingReport } from "./report"
import type { GroundingBucket, GroundingDecision, GroundingSeverity } from "./schema"
import { GROUNDING_BUCKETS } from "./schema"

export type GroundingComparabilityStatus = "match" | "mismatch" | "unknown"

export interface GroundingMetricDelta {
  baseline: number
  candidate: number
  delta: number
}

export interface GroundingMetricDeltaSet {
  thread_selection_accuracy: GroundingMetricDelta
  referent_accuracy: GroundingMetricDelta
  intent_accuracy: GroundingMetricDelta
  scope_accuracy: GroundingMetricDelta
  clarify_precision: GroundingMetricDelta
  clarify_recall: GroundingMetricDelta
  wrong_thread_rate: GroundingMetricDelta
  stale_context_attachment_rate: GroundingMetricDelta
  summary_equivalence_rate: GroundingMetricDelta
  exact_tuple_match_rate: GroundingMetricDelta
  structured_output_validity: GroundingMetricDelta
}

export interface GroundingBucketDelta {
  bucket: GroundingBucket
  baselineTotal: number
  candidateTotal: number
  baselineMaxSeverity?: GroundingSeverity
  candidateMaxSeverity?: GroundingSeverity
  baselineCriticalCases: number
  candidateCriticalCases: number
  baselineCounts: Record<Verdict, number>
  candidateCounts: Record<Verdict, number>
  metrics: GroundingMetricDeltaSet
}

export interface GroundingCaseChange {
  caseId: string
  bucket: GroundingBucket
  severity: GroundingSeverity
  kind: "regressed" | "improved" | "changed" | "missing_in_candidate" | "new_in_candidate"
  baselineVerdict?: Verdict
  candidateVerdict?: Verdict
  baselineErrorKind?: GroundingErrorKind
  candidateErrorKind?: GroundingErrorKind
  changedFields: readonly string[]
}

export interface GroundingComparisonReport {
  baselineRunId: string
  candidateRunId: string
  comparable: boolean
  comparability: {
    suite: Exclude<GroundingComparabilityStatus, "unknown">
    corpus: Exclude<GroundingComparabilityStatus, "unknown">
    mode: Exclude<GroundingComparabilityStatus, "unknown">
    probeProfile: GroundingComparabilityStatus
    normalizationProfile: GroundingComparabilityStatus
    harness: GroundingComparabilityStatus
    route: GroundingComparabilityStatus
    executionContract: GroundingComparabilityStatus
    caseSet: GroundingComparabilityStatus
    baselineCorpus?: string
    candidateCorpus?: string
    baselineMode?: string
    candidateMode?: string
    baselineProbeProfile?: string
    candidateProbeProfile?: string
    baselineNormalizationProfile?: string
    candidateNormalizationProfile?: string
    baselineHarnessFingerprint?: string
    candidateHarnessFingerprint?: string
    baselineRouteFingerprint?: string
    candidateRouteFingerprint?: string
    baselineExecutionContractFingerprint?: string
    candidateExecutionContractFingerprint?: string
    baselineCaseSetFingerprint?: string
    candidateCaseSetFingerprint?: string
  }
  baseline: Pick<
    GroundingReport,
    "suite" | "corpus" | "mode" | "route" | "counts" | "metrics" | "run"
  >
  candidate: Pick<
    GroundingReport,
    "suite" | "corpus" | "mode" | "route" | "counts" | "metrics" | "run"
  >
  metricDeltas: GroundingMetricDeltaSet
  bucketDeltas: readonly GroundingBucketDelta[]
  changes: readonly GroundingCaseChange[]
  regressions: readonly GroundingCaseChange[]
  improvements: readonly GroundingCaseChange[]
}

export interface GroundingComparisonOutput {
  headline: string
  markdown: string
  comparison: GroundingComparisonReport
}

const emptyCounts = (): Record<Verdict, number> => ({
  pass: 0,
  partial: 0,
  fail: 0,
  error: 0,
  skipped: 0,
})

const emptyMetrics = (): GroundingMetrics => ({
  thread_selection_accuracy: 0,
  referent_accuracy: 0,
  intent_accuracy: 0,
  scope_accuracy: 0,
  clarify_precision: 0,
  clarify_recall: 0,
  wrong_thread_rate: 0,
  stale_context_attachment_rate: 0,
  summary_equivalence_rate: 0,
  exact_tuple_match_rate: 0,
  structured_output_validity: 0,
})

const verdictRank: Record<Verdict, number> = {
  pass: 4,
  partial: 3,
  fail: 2,
  error: 1,
  skipped: 0,
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

const delta = (baseline: number, candidate: number): GroundingMetricDelta => ({
  baseline,
  candidate,
  delta: candidate - baseline,
})

const metricDeltaSet = (
  baseline: GroundingMetrics,
  candidate: GroundingMetrics,
): GroundingMetricDeltaSet => ({
  thread_selection_accuracy: delta(
    baseline.thread_selection_accuracy,
    candidate.thread_selection_accuracy,
  ),
  referent_accuracy: delta(baseline.referent_accuracy, candidate.referent_accuracy),
  intent_accuracy: delta(baseline.intent_accuracy, candidate.intent_accuracy),
  scope_accuracy: delta(baseline.scope_accuracy, candidate.scope_accuracy),
  clarify_precision: delta(baseline.clarify_precision, candidate.clarify_precision),
  clarify_recall: delta(baseline.clarify_recall, candidate.clarify_recall),
  wrong_thread_rate: delta(baseline.wrong_thread_rate, candidate.wrong_thread_rate),
  stale_context_attachment_rate: delta(
    baseline.stale_context_attachment_rate,
    candidate.stale_context_attachment_rate,
  ),
  summary_equivalence_rate: delta(
    baseline.summary_equivalence_rate,
    candidate.summary_equivalence_rate,
  ),
  exact_tuple_match_rate: delta(baseline.exact_tuple_match_rate, candidate.exact_tuple_match_rate),
  structured_output_validity: delta(
    baseline.structured_output_validity,
    candidate.structured_output_validity,
  ),
})

const bucketMap = (
  buckets: readonly GroundingBucketReport[],
): ReadonlyMap<GroundingBucket, GroundingBucketReport> =>
  new Map(buckets.map((bucket) => [bucket.bucket, bucket]))

const payloadMap = (payloads: readonly GroundingPayload[]): ReadonlyMap<string, GroundingPayload> =>
  new Map(payloads.map((payload) => [payload.caseId, payload]))

const changedDecisionFields = (
  baseline: GroundingDecision | undefined,
  candidate: GroundingDecision | undefined,
): string[] => {
  const out: string[] = []
  if (baseline?.activeThreadId !== candidate?.activeThreadId) out.push("activeThreadId")
  if (baseline?.referentId !== candidate?.referentId) out.push("referentId")
  if (baseline?.intent !== candidate?.intent) out.push("intent")
  if (baseline?.scope !== candidate?.scope) out.push("scope")
  if (baseline?.shouldClarify !== candidate?.shouldClarify) out.push("shouldClarify")
  if (baseline?.confidence !== candidate?.confidence) out.push("confidence")
  return out
}

/** A case present only in the candidate run. */
const appearedChange = (caseId: string, candidate: GroundingPayload): GroundingCaseChange => ({
  caseId,
  bucket: candidate.bucket,
  severity: candidate.severity,
  kind: "new_in_candidate",
  candidateVerdict: candidate.verdict,
  ...(candidate.errorKind !== undefined ? { candidateErrorKind: candidate.errorKind } : {}),
  changedFields: ["verdict", "actual"],
})

/** A case present only in the baseline run. */
const disappearedChange = (caseId: string, baseline: GroundingPayload): GroundingCaseChange => ({
  caseId,
  bucket: baseline.bucket,
  severity: baseline.severity,
  kind: "missing_in_candidate",
  baselineVerdict: baseline.verdict,
  ...(baseline.errorKind !== undefined ? { baselineErrorKind: baseline.errorKind } : {}),
  changedFields: ["verdict", "actual"],
})

/** A case present on BOTH sides: rank the two verdicts to say whether the drift
 *  is a regression, an improvement, or a same-rank change. `null` when nothing
 *  observable moved. */
const driftChange = (
  caseId: string,
  baseline: GroundingPayload | undefined,
  candidate: GroundingPayload | undefined,
): GroundingCaseChange | null => {
  const baselineVerdict = baseline?.verdict as Verdict
  const candidateVerdict = candidate?.verdict as Verdict
  const changedFields = changedDecisionFields(
    baseline?.scoredActual ?? baseline?.actual,
    candidate?.scoredActual ?? candidate?.actual,
  )
  if (baselineVerdict !== candidateVerdict) changedFields.push("verdict")
  if (baseline?.errorKind !== candidate?.errorKind) changedFields.push("errorKind")
  if (changedFields.length === 0) return null
  const baselineRank = verdictRank[baselineVerdict]
  const candidateRank = verdictRank[candidateVerdict]
  const kind =
    candidateRank < baselineRank
      ? "regressed"
      : candidateRank > baselineRank
        ? "improved"
        : "changed"
  return {
    caseId,
    bucket: baseline?.bucket ?? candidate?.bucket ?? "reference",
    severity: baseline?.severity ?? candidate?.severity ?? "medium",
    kind,
    baselineVerdict,
    candidateVerdict,
    ...(baseline?.errorKind !== undefined ? { baselineErrorKind: baseline.errorKind } : {}),
    ...(candidate?.errorKind !== undefined ? { candidateErrorKind: candidate.errorKind } : {}),
    changedFields,
  }
}

const caseChange = (
  caseId: string,
  baseline: GroundingPayload | undefined,
  candidate: GroundingPayload | undefined,
): GroundingCaseChange | null => {
  if (baseline === undefined && candidate === undefined) return null
  if (baseline === undefined && candidate !== undefined) return appearedChange(caseId, candidate)
  if (baseline !== undefined && candidate === undefined) return disappearedChange(caseId, baseline)
  return driftChange(caseId, baseline, candidate)
}

const renderRoute = (route: GroundingReport["route"]): string => {
  const bits = [route.provider, route.model, route.surfaceId, route.transportId].filter(
    (value): value is string => value !== undefined && value !== "",
  )
  if (route.authMode !== undefined) bits.push(`auth=${route.authMode}`)
  return bits.length > 0 ? bits.join(" / ") : "unknown"
}

const renderMetricDelta = (metric: GroundingMetricDelta): string =>
  `${pct(metric.baseline)} -> ${pct(metric.candidate)} (${metric.delta >= 0 ? "+" : ""}${pct(metric.delta)})`

const runParamString = (report: Pick<GroundingReport, "run">, key: string): string | undefined => {
  const value = report.run?.params?.[key]
  return typeof value === "string" ? value : undefined
}

const comparabilityStatus = (
  baseline: string | undefined,
  candidate: string | undefined,
): GroundingComparabilityStatus => {
  if (baseline === undefined || candidate === undefined) return "unknown"
  return baseline === candidate ? "match" : "mismatch"
}

const renderMarkdown = (comparison: GroundingComparisonReport): string => {
  const lines: string[] = []
  lines.push(`# Grounding Compare — ${comparison.baselineRunId} -> ${comparison.candidateRunId}`)
  lines.push("")
  lines.push(`Comparable: ${comparison.comparable ? "yes" : "no"}`)
  lines.push(`Baseline route: ${renderRoute(comparison.baseline.route)}`)
  lines.push(`Candidate route: ${renderRoute(comparison.candidate.route)}`)
  lines.push(
    `Suite: ${comparison.baseline.suite ?? "unknown"} -> ${comparison.candidate.suite ?? "unknown"}`,
  )
  lines.push(
    `Corpus: ${comparison.comparability.baselineCorpus ?? "unknown"} -> ${comparison.comparability.candidateCorpus ?? "unknown"}`,
  )
  lines.push(
    `Mode: ${comparison.comparability.baselineMode ?? "unknown"} -> ${comparison.comparability.candidateMode ?? "unknown"}`,
  )
  lines.push(
    `Comparability: suite=${comparison.comparability.suite}, corpus=${comparison.comparability.corpus}, mode=${comparison.comparability.mode}, probeProfile=${comparison.comparability.probeProfile}, normalizationProfile=${comparison.comparability.normalizationProfile}, harness=${comparison.comparability.harness}, route=${comparison.comparability.route}, executionContract=${comparison.comparability.executionContract}, caseSet=${comparison.comparability.caseSet}`,
  )
  lines.push("")
  lines.push("## Metrics")
  lines.push("")
  lines.push(
    `- thread_selection_accuracy: ${renderMetricDelta(comparison.metricDeltas.thread_selection_accuracy)}`,
  )
  lines.push(`- referent_accuracy: ${renderMetricDelta(comparison.metricDeltas.referent_accuracy)}`)
  lines.push(`- clarify_recall: ${renderMetricDelta(comparison.metricDeltas.clarify_recall)}`)
  lines.push(`- wrong_thread_rate: ${renderMetricDelta(comparison.metricDeltas.wrong_thread_rate)}`)
  lines.push(
    `- summary_equivalence_rate: ${renderMetricDelta(comparison.metricDeltas.summary_equivalence_rate)}`,
  )
  lines.push(
    `- exact_tuple_match_rate: ${renderMetricDelta(comparison.metricDeltas.exact_tuple_match_rate)}`,
  )
  lines.push(
    `- structured_output_validity: ${renderMetricDelta(comparison.metricDeltas.structured_output_validity)}`,
  )
  lines.push("")
  lines.push("## Buckets")
  lines.push("")
  lines.push(
    "| Bucket | Baseline | Candidate | Max Sev | Critical | Exact Δ | Wrong-thread Δ | Referent Δ | Clarify Recall Δ |",
  )
  lines.push("|---|---|---|---|---|---|---|---|---|")
  for (const bucket of comparison.bucketDeltas) {
    lines.push(
      `| ${bucket.bucket} | ${bucket.baselineTotal} | ${bucket.candidateTotal} | ${bucket.baselineMaxSeverity ?? "-"} -> ${bucket.candidateMaxSeverity ?? "-"} | ${bucket.baselineCriticalCases} -> ${bucket.candidateCriticalCases} | ${renderMetricDelta(bucket.metrics.exact_tuple_match_rate)} | ${renderMetricDelta(bucket.metrics.wrong_thread_rate)} | ${renderMetricDelta(bucket.metrics.referent_accuracy)} | ${renderMetricDelta(bucket.metrics.clarify_recall)} |`,
    )
  }
  if (comparison.changes.length > 0) {
    lines.push("")
    lines.push("## Case Drift")
    lines.push("")
    lines.push("| Case | Kind | Bucket | Severity | Baseline | Candidate | Fields |")
    lines.push("|---|---|---|---|---|---|---|")
    for (const change of comparison.changes) {
      lines.push(
        `| \`${change.caseId}\` | ${change.kind} | ${change.bucket} | ${change.severity} | ${change.baselineVerdict ?? "-"} | ${change.candidateVerdict ?? "-"} | ${change.changedFields.join(", ")} |`,
      )
    }
  }
  return lines.join("\n")
}

/**
 * The nine comparability STATUSES. `suite`/`corpus`/`mode` are stricter than
 * `comparabilityStatus`: an ABSENT value is a mismatch, not "unknown" — an
 * unlabelled run is not comparable at all, whereas a missing FINGERPRINT only
 * means the axis could not be verified.
 */
const comparabilityStatuses = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): Pick<
  GroundingComparisonReport["comparability"],
  | "suite"
  | "corpus"
  | "mode"
  | "probeProfile"
  | "normalizationProfile"
  | "harness"
  | "route"
  | "executionContract"
  | "caseSet"
> => ({
  suite: baseline.suite === candidate.suite ? "match" : "mismatch",
  corpus:
    baseline.corpus === undefined || candidate.corpus === undefined
      ? "mismatch"
      : baseline.corpus === candidate.corpus
        ? "match"
        : "mismatch",
  mode:
    baseline.mode === undefined || candidate.mode === undefined
      ? "mismatch"
      : baseline.mode === candidate.mode
        ? "match"
        : "mismatch",
  probeProfile: comparabilityStatus(
    runParamString(baseline, "probeProfile"),
    runParamString(candidate, "probeProfile"),
  ),
  normalizationProfile: comparabilityStatus(
    runParamString(baseline, "normalizationProfile"),
    runParamString(candidate, "normalizationProfile"),
  ),
  harness: comparabilityStatus(
    runParamString(baseline, "harnessFingerprint"),
    runParamString(candidate, "harnessFingerprint"),
  ),
  route: comparabilityStatus(
    runParamString(baseline, "routeFingerprint"),
    runParamString(candidate, "routeFingerprint"),
  ),
  executionContract: comparabilityStatus(
    runParamString(baseline, "executionContractFingerprint"),
    runParamString(candidate, "executionContractFingerprint"),
  ),
  caseSet: comparabilityStatus(
    runParamString(baseline, "caseSetFingerprint"),
    runParamString(candidate, "caseSetFingerprint"),
  ),
})

/** The identity VALUES behind the suite/corpus/mode statuses, echoed so a
 *  reader of the report can see what actually differed. Absent stays absent. */
const identityEvidence = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): Pick<
  GroundingComparisonReport["comparability"],
  "baselineCorpus" | "candidateCorpus" | "baselineMode" | "candidateMode"
> => ({
  ...(baseline.corpus !== undefined ? { baselineCorpus: baseline.corpus } : {}),
  ...(candidate.corpus !== undefined ? { candidateCorpus: candidate.corpus } : {}),
  ...(baseline.mode !== undefined ? { baselineMode: baseline.mode } : {}),
  ...(candidate.mode !== undefined ? { candidateMode: candidate.mode } : {}),
})

/** Same, for the six provenance FINGERPRINTS. */
const fingerprintEvidence = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): Pick<
  GroundingComparisonReport["comparability"],
  | "baselineProbeProfile"
  | "candidateProbeProfile"
  | "baselineNormalizationProfile"
  | "candidateNormalizationProfile"
  | "baselineHarnessFingerprint"
  | "candidateHarnessFingerprint"
  | "baselineRouteFingerprint"
  | "candidateRouteFingerprint"
  | "baselineExecutionContractFingerprint"
  | "candidateExecutionContractFingerprint"
  | "baselineCaseSetFingerprint"
  | "candidateCaseSetFingerprint"
> => {
  const baselineProbeProfile = runParamString(baseline, "probeProfile")
  const candidateProbeProfile = runParamString(candidate, "probeProfile")
  const baselineNormalizationProfile = runParamString(baseline, "normalizationProfile")
  const candidateNormalizationProfile = runParamString(candidate, "normalizationProfile")
  const baselineHarnessFingerprint = runParamString(baseline, "harnessFingerprint")
  const candidateHarnessFingerprint = runParamString(candidate, "harnessFingerprint")
  const baselineRouteFingerprint = runParamString(baseline, "routeFingerprint")
  const candidateRouteFingerprint = runParamString(candidate, "routeFingerprint")
  const baselineExecutionContractFingerprint = runParamString(
    baseline,
    "executionContractFingerprint",
  )
  const candidateExecutionContractFingerprint = runParamString(
    candidate,
    "executionContractFingerprint",
  )
  const baselineCaseSetFingerprint = runParamString(baseline, "caseSetFingerprint")
  const candidateCaseSetFingerprint = runParamString(candidate, "caseSetFingerprint")
  return {
    ...(baselineProbeProfile !== undefined ? { baselineProbeProfile } : {}),
    ...(candidateProbeProfile !== undefined ? { candidateProbeProfile } : {}),
    ...(baselineNormalizationProfile !== undefined ? { baselineNormalizationProfile } : {}),
    ...(candidateNormalizationProfile !== undefined ? { candidateNormalizationProfile } : {}),
    ...(baselineHarnessFingerprint !== undefined ? { baselineHarnessFingerprint } : {}),
    ...(candidateHarnessFingerprint !== undefined ? { candidateHarnessFingerprint } : {}),
    ...(baselineRouteFingerprint !== undefined ? { baselineRouteFingerprint } : {}),
    ...(candidateRouteFingerprint !== undefined ? { candidateRouteFingerprint } : {}),
    ...(baselineExecutionContractFingerprint !== undefined
      ? { baselineExecutionContractFingerprint }
      : {}),
    ...(candidateExecutionContractFingerprint !== undefined
      ? { candidateExecutionContractFingerprint }
      : {}),
    ...(baselineCaseSetFingerprint !== undefined ? { baselineCaseSetFingerprint } : {}),
    ...(candidateCaseSetFingerprint !== undefined ? { candidateCaseSetFingerprint } : {}),
  }
}

/**
 * The COMPARABILITY block: for every axis, is the baseline/candidate pair the
 * same experiment? Pure provenance bookkeeping — it reads only `run.params`
 * fingerprints and the two reports' identity fields, nothing about outcomes.
 * Statuses first, then the evidence values, in that key order.
 */
const buildComparability = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): GroundingComparisonReport["comparability"] => ({
  ...comparabilityStatuses(baseline, candidate),
  ...identityEvidence(baseline, candidate),
  ...fingerprintEvidence(baseline, candidate),
})

/** One bucket's baseline-vs-candidate row. */
const bucketDelta = (
  bucket: GroundingBucket,
  left: GroundingBucketReport | undefined,
  right: GroundingBucketReport | undefined,
): GroundingBucketDelta => ({
  bucket,
  baselineTotal: left?.total ?? 0,
  candidateTotal: right?.total ?? 0,
  ...(left?.maxSeverity !== undefined ? { baselineMaxSeverity: left.maxSeverity } : {}),
  ...(right?.maxSeverity !== undefined ? { candidateMaxSeverity: right.maxSeverity } : {}),
  baselineCriticalCases: left?.criticalCases ?? 0,
  candidateCriticalCases: right?.criticalCases ?? 0,
  baselineCounts: left?.counts ?? emptyCounts(),
  candidateCounts: right?.counts ?? emptyCounts(),
  metrics: metricDeltaSet(left?.metrics ?? emptyMetrics(), right?.metrics ?? emptyMetrics()),
})

/** Bucket rows for every bucket EITHER side reported, in canonical order. */
const buildBucketDeltas = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): readonly GroundingBucketDelta[] => {
  const baselineBuckets = bucketMap(baseline.buckets)
  const candidateBuckets = bucketMap(candidate.buckets)
  const bucketDeltas: GroundingBucketDelta[] = []
  for (const bucket of GROUNDING_BUCKETS) {
    const left = baselineBuckets.get(bucket)
    const right = candidateBuckets.get(bucket)
    if (left === undefined && right === undefined) continue
    bucketDeltas.push(bucketDelta(bucket, left, right))
  }
  return bucketDeltas
}

interface CaseDiff {
  readonly changes: readonly GroundingCaseChange[]
  readonly regressions: readonly GroundingCaseChange[]
  readonly improvements: readonly GroundingCaseChange[]
}

/** The per-case drift set, over the UNION of both runs' case ids (sorted, so
 *  the report is deterministic), pre-partitioned into the two directions. */
const buildCaseDiff = (baseline: GroundingReport, candidate: GroundingReport): CaseDiff => {
  const left = payloadMap(baseline.payloads)
  const right = payloadMap(candidate.payloads)
  const ids = new Set<string>([...left.keys(), ...right.keys()])
  const changes: GroundingCaseChange[] = []
  const regressions: GroundingCaseChange[] = []
  const improvements: GroundingCaseChange[] = []
  for (const caseId of [...ids].sort()) {
    const change = caseChange(caseId, left.get(caseId), right.get(caseId))
    if (change === null) continue
    changes.push(change)
    if (change.kind === "regressed" || change.kind === "missing_in_candidate")
      regressions.push(change)
    if (change.kind === "improved" || change.kind === "new_in_candidate") improvements.push(change)
  }
  return { changes, regressions, improvements }
}

/** One run's side of the report, narrowed to the fields the comparison keeps. */
const reportSide = (report: GroundingReport): GroundingComparisonReport["baseline"] => ({
  route: report.route,
  counts: report.counts,
  metrics: report.metrics,
  ...(report.suite !== undefined ? { suite: report.suite } : {}),
  ...(report.corpus !== undefined ? { corpus: report.corpus } : {}),
  ...(report.mode !== undefined ? { mode: report.mode } : {}),
  ...(report.run !== undefined ? { run: report.run } : {}),
})

/** Two runs are comparable only when EVERY provenance axis matches and neither
 *  side carries a case the other lacks. */
const isComparable = (
  comparability: GroundingComparisonReport["comparability"],
  diff: CaseDiff,
): boolean =>
  comparability.suite === "match" &&
  comparability.corpus === "match" &&
  comparability.mode === "match" &&
  comparability.probeProfile === "match" &&
  comparability.normalizationProfile === "match" &&
  comparability.harness === "match" &&
  comparability.route === "match" &&
  comparability.executionContract === "match" &&
  comparability.caseSet === "match" &&
  diff.regressions.every((change) => change.kind !== "missing_in_candidate") &&
  diff.changes.every((change) => change.kind !== "new_in_candidate")

export const buildGroundingComparison = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): GroundingComparisonOutput => {
  const comparability = buildComparability(baseline, candidate)
  const diff = buildCaseDiff(baseline, candidate)
  const comparison: GroundingComparisonReport = {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    comparable: isComparable(comparability, diff),
    comparability,
    baseline: reportSide(baseline),
    candidate: reportSide(candidate),
    metricDeltas: metricDeltaSet(baseline.metrics, candidate.metrics),
    bucketDeltas: buildBucketDeltas(baseline, candidate),
    changes: diff.changes,
    regressions: diff.regressions,
    improvements: diff.improvements,
  }

  const headline = `compare baseline=${baseline.runId} candidate=${candidate.runId} regressions=${diff.regressions.length} improvements=${diff.improvements.length} exact=${renderMetricDelta(comparison.metricDeltas.exact_tuple_match_rate)}`
  return {
    headline,
    markdown: renderMarkdown(comparison),
    comparison,
  }
}

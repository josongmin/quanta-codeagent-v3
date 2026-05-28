import type { GroundingPayload } from "../storage"
import type { Verdict } from "../types"
import type { GroundingErrorKind } from "./diagnostics"
import type { GroundingBucket, GroundingDecision, GroundingSeverity } from "./schema"
import { GROUNDING_BUCKETS } from "./schema"
import type { GroundingBucketReport, GroundingMetrics, GroundingReport } from "./report"

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
  baseline: Pick<GroundingReport, "suite" | "corpus" | "mode" | "route" | "counts" | "metrics" | "run">
  candidate: Pick<GroundingReport, "suite" | "corpus" | "mode" | "route" | "counts" | "metrics" | "run">
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

export const GROUNDING_REGRESSION_PROFILES = ["strict"] as const
export type GroundingRegressionProfile = (typeof GROUNDING_REGRESSION_PROFILES)[number]

export interface GroundingRegressionFailure {
  kind:
    | "suite_mismatch"
    | "corpus_mismatch"
    | "mode_mismatch"
    | "probe_profile_unverified"
    | "probe_profile_mismatch"
    | "normalization_profile_unverified"
    | "normalization_profile_mismatch"
    | "harness_unverified"
    | "harness_mismatch"
    | "route_unverified"
    | "route_mismatch"
    | "execution_contract_unverified"
    | "execution_contract_mismatch"
    | "case_fingerprint_unverified"
    | "case_fingerprint_mismatch"
    | "case_set_mismatch"
    | "error_count_increase"
    | "wrong_thread_rate_increase"
    | "clarify_recall_decrease"
    | "summary_equivalence_rate_decrease"
    | "thread_selection_accuracy_decrease"
    | "referent_accuracy_decrease"
    | "exact_tuple_match_rate_decrease"
    | "structured_output_validity_decrease"
    | "critical_bucket_regression"
    | "case_regression"
  message: string
  caseId?: string
  bucket?: GroundingBucket
  severity?: GroundingSeverity
  baseline?: number | string
  candidate?: number | string
}

export interface GroundingRegressionResult {
  baselineRunId: string
  candidateRunId: string
  profile: GroundingRegressionProfile
  passed: boolean
  comparable: boolean
  comparability: GroundingComparisonReport["comparability"]
  failures: readonly GroundingRegressionFailure[]
}

export interface GroundingRegressionOutput {
  headline: string
  markdown: string
  result: GroundingRegressionResult
}

export const isGroundingRegressionProfile = (
  value: string,
): value is GroundingRegressionProfile =>
  GROUNDING_REGRESSION_PROFILES.includes(value as GroundingRegressionProfile)

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
  exact_tuple_match_rate: delta(
    baseline.exact_tuple_match_rate,
    candidate.exact_tuple_match_rate,
  ),
  structured_output_validity: delta(
    baseline.structured_output_validity,
    candidate.structured_output_validity,
  ),
})

const bucketMap = (
  buckets: readonly GroundingBucketReport[],
): ReadonlyMap<GroundingBucket, GroundingBucketReport> =>
  new Map(buckets.map((bucket) => [bucket.bucket, bucket]))

const payloadMap = (
  payloads: readonly GroundingPayload[],
): ReadonlyMap<string, GroundingPayload> =>
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

const caseChange = (
  caseId: string,
  baseline: GroundingPayload | undefined,
  candidate: GroundingPayload | undefined,
): GroundingCaseChange | null => {
  if (baseline === undefined && candidate === undefined) return null
  if (baseline === undefined && candidate !== undefined) {
    return {
      caseId,
      bucket: candidate.bucket,
      severity: candidate.severity,
      kind: "new_in_candidate",
      candidateVerdict: candidate.verdict,
      ...(candidate.errorKind !== undefined ? { candidateErrorKind: candidate.errorKind } : {}),
      changedFields: ["verdict", "actual"],
    }
  }
  if (baseline !== undefined && candidate === undefined) {
    return {
      caseId,
      bucket: baseline.bucket,
      severity: baseline.severity,
      kind: "missing_in_candidate",
      baselineVerdict: baseline.verdict,
      ...(baseline.errorKind !== undefined ? { baselineErrorKind: baseline.errorKind } : {}),
      changedFields: ["verdict", "actual"],
    }
  }
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
  lines.push(
    `# Grounding Compare — ${comparison.baselineRunId} -> ${comparison.candidateRunId}`,
  )
  lines.push("")
  lines.push(`Comparable: ${comparison.comparable ? "yes" : "no"}`)
  lines.push(`Baseline route: ${renderRoute(comparison.baseline.route)}`)
  lines.push(`Candidate route: ${renderRoute(comparison.candidate.route)}`)
  lines.push(`Suite: ${comparison.baseline.suite ?? "unknown"} -> ${comparison.candidate.suite ?? "unknown"}`)
  lines.push(`Corpus: ${comparison.comparability.baselineCorpus ?? "unknown"} -> ${comparison.comparability.candidateCorpus ?? "unknown"}`)
  lines.push(`Mode: ${comparison.comparability.baselineMode ?? "unknown"} -> ${comparison.comparability.candidateMode ?? "unknown"}`)
  lines.push(
    `Comparability: suite=${comparison.comparability.suite}, corpus=${comparison.comparability.corpus}, mode=${comparison.comparability.mode}, probeProfile=${comparison.comparability.probeProfile}, normalizationProfile=${comparison.comparability.normalizationProfile}, harness=${comparison.comparability.harness}, route=${comparison.comparability.route}, executionContract=${comparison.comparability.executionContract}, caseSet=${comparison.comparability.caseSet}`,
  )
  lines.push("")
  lines.push("## Metrics")
  lines.push("")
  lines.push(`- thread_selection_accuracy: ${renderMetricDelta(comparison.metricDeltas.thread_selection_accuracy)}`)
  lines.push(`- referent_accuracy: ${renderMetricDelta(comparison.metricDeltas.referent_accuracy)}`)
  lines.push(`- clarify_recall: ${renderMetricDelta(comparison.metricDeltas.clarify_recall)}`)
  lines.push(`- wrong_thread_rate: ${renderMetricDelta(comparison.metricDeltas.wrong_thread_rate)}`)
  lines.push(`- summary_equivalence_rate: ${renderMetricDelta(comparison.metricDeltas.summary_equivalence_rate)}`)
  lines.push(`- exact_tuple_match_rate: ${renderMetricDelta(comparison.metricDeltas.exact_tuple_match_rate)}`)
  lines.push(`- structured_output_validity: ${renderMetricDelta(comparison.metricDeltas.structured_output_validity)}`)
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

const renderRegressionMarkdown = (result: GroundingRegressionResult): string => {
  const lines: string[] = []
  lines.push(`# Grounding Regression Gate — ${result.baselineRunId} -> ${result.candidateRunId}`)
  lines.push("")
  lines.push(`Profile: ${result.profile}`)
  lines.push(`Status: ${result.passed ? "PASS" : "FAIL"}`)
  lines.push(`Comparable: ${result.comparable ? "yes" : "no"}`)
  lines.push(
    `Comparability: suite=${result.comparability.suite}, corpus=${result.comparability.corpus}, mode=${result.comparability.mode}, probeProfile=${result.comparability.probeProfile}, normalizationProfile=${result.comparability.normalizationProfile}, harness=${result.comparability.harness}, route=${result.comparability.route}, executionContract=${result.comparability.executionContract}, caseSet=${result.comparability.caseSet}`,
  )
  lines.push("")
  lines.push("## Failures")
  lines.push("")
  if (result.failures.length === 0) {
    lines.push("- none")
  } else {
    for (const failure of result.failures) {
      lines.push(`- ${failure.kind}: ${failure.message}`)
    }
  }
  return lines.join("\n")
}

const addCriticalBucketFailure = (
  failures: GroundingRegressionFailure[],
  bucket: GroundingBucketDelta,
  metric: string,
  baseline: number,
  candidate: number,
): void => {
  failures.push({
    kind: "critical_bucket_regression",
    message: `${bucket.bucket} critical bucket regressed on ${metric}`,
    bucket: bucket.bucket,
    severity: bucket.baselineMaxSeverity ?? bucket.candidateMaxSeverity ?? "critical",
    baseline,
    candidate,
  })
}

const criticalBucketFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] => {
  const failures: GroundingRegressionFailure[] = []
  for (const bucket of comparison.bucketDeltas) {
    if (Math.max(bucket.baselineCriticalCases, bucket.candidateCriticalCases) === 0) continue
    if (bucket.metrics.wrong_thread_rate.delta > 0) {
      addCriticalBucketFailure(
        failures,
        bucket,
        "wrong_thread_rate",
        bucket.metrics.wrong_thread_rate.baseline,
        bucket.metrics.wrong_thread_rate.candidate,
      )
    }
    if (bucket.metrics.exact_tuple_match_rate.delta < 0) {
      addCriticalBucketFailure(
        failures,
        bucket,
        "exact_tuple_match_rate",
        bucket.metrics.exact_tuple_match_rate.baseline,
        bucket.metrics.exact_tuple_match_rate.candidate,
      )
    }
    switch (bucket.bucket) {
      case "must_clarify":
        if (bucket.metrics.clarify_recall.delta < 0) {
          addCriticalBucketFailure(
            failures,
            bucket,
            "clarify_recall",
            bucket.metrics.clarify_recall.baseline,
            bucket.metrics.clarify_recall.candidate,
          )
        }
        break
      case "summary_equivalence":
        if (bucket.metrics.summary_equivalence_rate.delta < 0) {
          addCriticalBucketFailure(
            failures,
            bucket,
            "summary_equivalence_rate",
            bucket.metrics.summary_equivalence_rate.baseline,
            bucket.metrics.summary_equivalence_rate.candidate,
          )
        }
        break
      case "stale_context_trap":
        if (bucket.metrics.stale_context_attachment_rate.delta > 0) {
          addCriticalBucketFailure(
            failures,
            bucket,
            "stale_context_attachment_rate",
            bucket.metrics.stale_context_attachment_rate.baseline,
            bucket.metrics.stale_context_attachment_rate.candidate,
          )
        }
        break
      default:
        if (bucket.metrics.referent_accuracy.delta < 0) {
          addCriticalBucketFailure(
            failures,
            bucket,
            "referent_accuracy",
            bucket.metrics.referent_accuracy.baseline,
            bucket.metrics.referent_accuracy.candidate,
          )
        }
        break
    }
  }
  return failures
}

export const buildGroundingComparison = (
  baseline: GroundingReport,
  candidate: GroundingReport,
): GroundingComparisonOutput => {
  const baselineBuckets = bucketMap(baseline.buckets)
  const candidateBuckets = bucketMap(candidate.buckets)
  const corpusStatus =
    baseline.corpus === undefined || candidate.corpus === undefined
      ? "mismatch"
      : baseline.corpus === candidate.corpus
        ? "match"
        : "mismatch"
  const modeStatus =
    baseline.mode === undefined || candidate.mode === undefined
      ? "mismatch"
      : baseline.mode === candidate.mode
        ? "match"
        : "mismatch"
  const probeProfileStatus = comparabilityStatus(
    runParamString(baseline, "probeProfile"),
    runParamString(candidate, "probeProfile"),
  )
  const normalizationProfileStatus = comparabilityStatus(
    runParamString(baseline, "normalizationProfile"),
    runParamString(candidate, "normalizationProfile"),
  )
  const routeStatus = comparabilityStatus(
    runParamString(baseline, "routeFingerprint"),
    runParamString(candidate, "routeFingerprint"),
  )
  const executionContractStatus = comparabilityStatus(
    runParamString(baseline, "executionContractFingerprint"),
    runParamString(candidate, "executionContractFingerprint"),
  )
  const caseSetStatus = comparabilityStatus(
    runParamString(baseline, "caseSetFingerprint"),
    runParamString(candidate, "caseSetFingerprint"),
  )
  const harnessStatus = comparabilityStatus(
    runParamString(baseline, "harnessFingerprint"),
    runParamString(candidate, "harnessFingerprint"),
  )
  const baselineHarnessFingerprint = runParamString(baseline, "harnessFingerprint")
  const candidateHarnessFingerprint = runParamString(candidate, "harnessFingerprint")
  const baselineProbeProfile = runParamString(baseline, "probeProfile")
  const candidateProbeProfile = runParamString(candidate, "probeProfile")
  const baselineNormalizationProfile = runParamString(baseline, "normalizationProfile")
  const candidateNormalizationProfile = runParamString(candidate, "normalizationProfile")
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
  const bucketDeltas: GroundingBucketDelta[] = []
  for (const bucket of GROUNDING_BUCKETS) {
    const left = baselineBuckets.get(bucket)
    const right = candidateBuckets.get(bucket)
    if (left === undefined && right === undefined) continue
    bucketDeltas.push({
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
  }

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
    if (change.kind === "regressed" || change.kind === "missing_in_candidate") regressions.push(change)
    if (change.kind === "improved" || change.kind === "new_in_candidate") improvements.push(change)
  }

  const comparison: GroundingComparisonReport = {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    comparable:
      baseline.suite === candidate.suite &&
      corpusStatus === "match" &&
      modeStatus === "match" &&
      probeProfileStatus === "match" &&
      normalizationProfileStatus === "match" &&
      harnessStatus === "match" &&
      routeStatus === "match" &&
      executionContractStatus === "match" &&
      caseSetStatus === "match" &&
      regressions.every((change) => change.kind !== "missing_in_candidate") &&
      changes.every((change) => change.kind !== "new_in_candidate"),
    comparability: {
      suite: baseline.suite === candidate.suite ? "match" : "mismatch",
      corpus: corpusStatus,
      mode: modeStatus,
      probeProfile: probeProfileStatus,
      normalizationProfile: normalizationProfileStatus,
      harness: harnessStatus,
      route: routeStatus,
      executionContract: executionContractStatus,
      caseSet: caseSetStatus,
      ...(baseline.corpus !== undefined ? { baselineCorpus: baseline.corpus } : {}),
      ...(candidate.corpus !== undefined ? { candidateCorpus: candidate.corpus } : {}),
      ...(baseline.mode !== undefined ? { baselineMode: baseline.mode } : {}),
      ...(candidate.mode !== undefined ? { candidateMode: candidate.mode } : {}),
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
    },
    baseline: {
      route: baseline.route,
      counts: baseline.counts,
      metrics: baseline.metrics,
      ...(baseline.suite !== undefined ? { suite: baseline.suite } : {}),
      ...(baseline.corpus !== undefined ? { corpus: baseline.corpus } : {}),
      ...(baseline.mode !== undefined ? { mode: baseline.mode } : {}),
      ...(baseline.run !== undefined ? { run: baseline.run } : {}),
    },
    candidate: {
      route: candidate.route,
      counts: candidate.counts,
      metrics: candidate.metrics,
      ...(candidate.suite !== undefined ? { suite: candidate.suite } : {}),
      ...(candidate.corpus !== undefined ? { corpus: candidate.corpus } : {}),
      ...(candidate.mode !== undefined ? { mode: candidate.mode } : {}),
      ...(candidate.run !== undefined ? { run: candidate.run } : {}),
    },
    metricDeltas: metricDeltaSet(baseline.metrics, candidate.metrics),
    bucketDeltas,
    changes,
    regressions,
    improvements,
  }

  const headline = `compare baseline=${baseline.runId} candidate=${candidate.runId} regressions=${regressions.length} improvements=${improvements.length} exact=${renderMetricDelta(comparison.metricDeltas.exact_tuple_match_rate)}`
  return {
    headline,
    markdown: renderMarkdown(comparison),
    comparison,
  }
}

export const evaluateGroundingRegression = (
  comparison: GroundingComparisonReport,
  profile: GroundingRegressionProfile,
): readonly GroundingRegressionFailure[] => {
  switch (profile) {
    case "strict": {
      const failures: GroundingRegressionFailure[] = []
      if (comparison.baseline.suite !== comparison.candidate.suite) {
        failures.push({
          kind: "suite_mismatch",
          message: "baseline and candidate suites differ",
          baseline: comparison.baseline.suite ?? "unknown",
          candidate: comparison.candidate.suite ?? "unknown",
        })
      }
      if (comparison.comparability.corpus === "mismatch") {
        failures.push({
          kind: "corpus_mismatch",
          message: "baseline and candidate corpora differ",
          baseline: comparison.comparability.baselineCorpus ?? "unknown",
          candidate: comparison.comparability.candidateCorpus ?? "unknown",
        })
      }
      if (comparison.comparability.mode === "mismatch") {
        failures.push({
          kind: "mode_mismatch",
          message: "baseline and candidate modes differ",
          baseline: comparison.comparability.baselineMode ?? "unknown",
          candidate: comparison.comparability.candidateMode ?? "unknown",
        })
      }
      if (comparison.comparability.probeProfile === "unknown") {
        failures.push({
          kind: "probe_profile_unverified",
          message: "missing probe profiles; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineProbeProfile ?? "unknown",
          candidate: comparison.comparability.candidateProbeProfile ?? "unknown",
        })
      }
      if (comparison.comparability.probeProfile === "mismatch") {
        failures.push({
          kind: "probe_profile_mismatch",
          message: "baseline and candidate probe profiles differ",
          baseline: comparison.comparability.baselineProbeProfile ?? "unknown",
          candidate: comparison.comparability.candidateProbeProfile ?? "unknown",
        })
      }
      if (comparison.comparability.normalizationProfile === "unknown") {
        failures.push({
          kind: "normalization_profile_unverified",
          message: "missing normalization profiles; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineNormalizationProfile ?? "unknown",
          candidate: comparison.comparability.candidateNormalizationProfile ?? "unknown",
        })
      }
      if (comparison.comparability.normalizationProfile === "mismatch") {
        failures.push({
          kind: "normalization_profile_mismatch",
          message: "baseline and candidate normalization profiles differ",
          baseline: comparison.comparability.baselineNormalizationProfile ?? "unknown",
          candidate: comparison.comparability.candidateNormalizationProfile ?? "unknown",
        })
      }
      if (comparison.comparability.harness === "unknown") {
        failures.push({
          kind: "harness_unverified",
          message: "missing harness fingerprints; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineHarnessFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateHarnessFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.harness === "mismatch") {
        failures.push({
          kind: "harness_mismatch",
          message: "baseline and candidate harness fingerprints differ",
          baseline: comparison.comparability.baselineHarnessFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateHarnessFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.route === "unknown") {
        failures.push({
          kind: "route_unverified",
          message: "missing route fingerprints; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineRouteFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateRouteFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.route === "mismatch") {
        failures.push({
          kind: "route_mismatch",
          message: "baseline and candidate route fingerprints differ",
          baseline: comparison.comparability.baselineRouteFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateRouteFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.executionContract === "unknown") {
        failures.push({
          kind: "execution_contract_unverified",
          message: "missing execution contract fingerprints; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineExecutionContractFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateExecutionContractFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.executionContract === "mismatch") {
        failures.push({
          kind: "execution_contract_mismatch",
          message: "baseline and candidate execution contract fingerprints differ",
          baseline: comparison.comparability.baselineExecutionContractFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateExecutionContractFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.caseSet === "unknown") {
        failures.push({
          kind: "case_fingerprint_unverified",
          message: "missing case-set fingerprints; comparison is not structurally verifiable",
          baseline: comparison.comparability.baselineCaseSetFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateCaseSetFingerprint ?? "unknown",
        })
      }
      if (comparison.comparability.caseSet === "mismatch") {
        failures.push({
          kind: "case_fingerprint_mismatch",
          message: "baseline and candidate case-set fingerprints differ",
          baseline: comparison.comparability.baselineCaseSetFingerprint ?? "unknown",
          candidate: comparison.comparability.candidateCaseSetFingerprint ?? "unknown",
        })
      }
      const setMismatches = comparison.changes.filter(
        (change) => change.kind === "missing_in_candidate" || change.kind === "new_in_candidate",
      )
      for (const change of setMismatches) {
        failures.push({
          kind: "case_set_mismatch",
          message: `${change.caseId} is ${change.kind.replaceAll("_", " ")}`,
          caseId: change.caseId,
          bucket: change.bucket,
          severity: change.severity,
        })
      }
      if (comparison.candidate.counts.error > comparison.baseline.counts.error) {
        failures.push({
          kind: "error_count_increase",
          message: "candidate introduced additional harness errors",
          baseline: comparison.baseline.counts.error,
          candidate: comparison.candidate.counts.error,
        })
      }
      const metrics = comparison.metricDeltas
      if (metrics.wrong_thread_rate.delta > 0) {
        failures.push({
          kind: "wrong_thread_rate_increase",
          message: "wrong-thread rate increased",
          baseline: metrics.wrong_thread_rate.baseline,
          candidate: metrics.wrong_thread_rate.candidate,
        })
      }
      if (metrics.clarify_recall.delta < 0) {
        failures.push({
          kind: "clarify_recall_decrease",
          message: "clarify recall decreased",
          baseline: metrics.clarify_recall.baseline,
          candidate: metrics.clarify_recall.candidate,
        })
      }
      if (metrics.summary_equivalence_rate.delta < 0) {
        failures.push({
          kind: "summary_equivalence_rate_decrease",
          message: "summary equivalence decreased",
          baseline: metrics.summary_equivalence_rate.baseline,
          candidate: metrics.summary_equivalence_rate.candidate,
        })
      }
      if (metrics.thread_selection_accuracy.delta < 0) {
        failures.push({
          kind: "thread_selection_accuracy_decrease",
          message: "thread selection accuracy decreased",
          baseline: metrics.thread_selection_accuracy.baseline,
          candidate: metrics.thread_selection_accuracy.candidate,
        })
      }
      if (metrics.referent_accuracy.delta < 0) {
        failures.push({
          kind: "referent_accuracy_decrease",
          message: "referent accuracy decreased",
          baseline: metrics.referent_accuracy.baseline,
          candidate: metrics.referent_accuracy.candidate,
        })
      }
      if (metrics.exact_tuple_match_rate.delta < 0) {
        failures.push({
          kind: "exact_tuple_match_rate_decrease",
          message: "exact tuple match rate decreased",
          baseline: metrics.exact_tuple_match_rate.baseline,
          candidate: metrics.exact_tuple_match_rate.candidate,
        })
      }
      if (metrics.structured_output_validity.delta < 0) {
        failures.push({
          kind: "structured_output_validity_decrease",
          message: "structured output validity decreased",
          baseline: metrics.structured_output_validity.baseline,
          candidate: metrics.structured_output_validity.candidate,
        })
      }
      failures.push(...criticalBucketFailures(comparison))
      for (const regression of comparison.regressions) {
        if (regression.kind !== "regressed") continue
        failures.push({
          kind: "case_regression",
          message: `${regression.caseId} regressed ${regression.baselineVerdict} -> ${regression.candidateVerdict}`,
          caseId: regression.caseId,
          bucket: regression.bucket,
          severity: regression.severity,
          baseline: regression.baselineVerdict ?? "unknown",
          candidate: regression.candidateVerdict ?? "unknown",
        })
      }
      return failures
    }
  }
}

export const buildGroundingRegressionResult = (
  comparison: GroundingComparisonReport,
  profile: GroundingRegressionProfile,
): GroundingRegressionOutput => {
  const failures = evaluateGroundingRegression(comparison, profile)
  const result: GroundingRegressionResult = {
    baselineRunId: comparison.baselineRunId,
    candidateRunId: comparison.candidateRunId,
    profile,
    passed: failures.length === 0,
    comparable: comparison.comparable,
    comparability: comparison.comparability,
    failures,
  }
  return {
    headline: `${result.passed ? "PASS" : "FAIL"} profile=${profile} baseline=${comparison.baselineRunId} candidate=${comparison.candidateRunId} failures=${failures.length}`,
    markdown: renderRegressionMarkdown(result),
    result,
  }
}

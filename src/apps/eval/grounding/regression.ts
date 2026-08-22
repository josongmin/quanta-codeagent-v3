/**
 * Grounding REGRESSION GATE — the pass/fail verdict layer over a comparison.
 *
 * Split out of `compare.ts`: that module answers "what changed between two
 * runs?", this one answers "is that change allowed to land?". They share only
 * the comparison report type, so the gate's failure taxonomy, its rendering and
 * its per-axis rules live here.
 */
import type {
  GroundingBucketDelta,
  GroundingComparisonReport,
  GroundingMetricDeltaSet,
} from "./compare"
import type { GroundingBucket, GroundingSeverity } from "./schema"

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

export const isGroundingRegressionProfile = (value: string): value is GroundingRegressionProfile =>
  GROUNDING_REGRESSION_PROFILES.includes(value as GroundingRegressionProfile)

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

/** A metric regresses either by going UP (rates we want low) or DOWN (accuracy). */
type MetricDirection = "increase" | "decrease"

const regressed = (delta: number, direction: MetricDirection): boolean =>
  direction === "increase" ? delta > 0 : delta < 0

// ── Axis 1: identity ─────────────────────────────────────────────────────────
// Suite / corpus / mode are the run's IDENTITY. A difference here does not mean
// the candidate got worse; it means the two runs are not the same experiment.

const identityAxisFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] => {
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
  return failures
}

// ── Axis 2: provenance fingerprints ──────────────────────────────────────────
// Every fingerprint axis fails the SAME two ways: absent on either side
// ("unverified" — the comparison cannot be structurally trusted) or present and
// different ("mismatch"). One table, applied in the declared order.

type Comparability = GroundingComparisonReport["comparability"]

interface ProvenanceAxis {
  readonly status: keyof Pick<
    Comparability,
    "probeProfile" | "normalizationProfile" | "harness" | "route" | "executionContract" | "caseSet"
  >
  readonly unverifiedKind: GroundingRegressionFailure["kind"]
  readonly mismatchKind: GroundingRegressionFailure["kind"]
  readonly unverifiedMessage: string
  readonly mismatchMessage: string
  readonly baselineValue: keyof Comparability
  readonly candidateValue: keyof Comparability
}

const PROVENANCE_AXES: readonly ProvenanceAxis[] = [
  {
    status: "probeProfile",
    unverifiedKind: "probe_profile_unverified",
    mismatchKind: "probe_profile_mismatch",
    unverifiedMessage: "missing probe profiles; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate probe profiles differ",
    baselineValue: "baselineProbeProfile",
    candidateValue: "candidateProbeProfile",
  },
  {
    status: "normalizationProfile",
    unverifiedKind: "normalization_profile_unverified",
    mismatchKind: "normalization_profile_mismatch",
    unverifiedMessage: "missing normalization profiles; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate normalization profiles differ",
    baselineValue: "baselineNormalizationProfile",
    candidateValue: "candidateNormalizationProfile",
  },
  {
    status: "harness",
    unverifiedKind: "harness_unverified",
    mismatchKind: "harness_mismatch",
    unverifiedMessage: "missing harness fingerprints; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate harness fingerprints differ",
    baselineValue: "baselineHarnessFingerprint",
    candidateValue: "candidateHarnessFingerprint",
  },
  {
    status: "route",
    unverifiedKind: "route_unverified",
    mismatchKind: "route_mismatch",
    unverifiedMessage: "missing route fingerprints; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate route fingerprints differ",
    baselineValue: "baselineRouteFingerprint",
    candidateValue: "candidateRouteFingerprint",
  },
  {
    status: "executionContract",
    unverifiedKind: "execution_contract_unverified",
    mismatchKind: "execution_contract_mismatch",
    unverifiedMessage:
      "missing execution contract fingerprints; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate execution contract fingerprints differ",
    baselineValue: "baselineExecutionContractFingerprint",
    candidateValue: "candidateExecutionContractFingerprint",
  },
  {
    status: "caseSet",
    unverifiedKind: "case_fingerprint_unverified",
    mismatchKind: "case_fingerprint_mismatch",
    unverifiedMessage: "missing case-set fingerprints; comparison is not structurally verifiable",
    mismatchMessage: "baseline and candidate case-set fingerprints differ",
    baselineValue: "baselineCaseSetFingerprint",
    candidateValue: "candidateCaseSetFingerprint",
  },
]

const provenanceAxisFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] => {
  const comparability = comparison.comparability
  const failures: GroundingRegressionFailure[] = []
  for (const axis of PROVENANCE_AXES) {
    const status = comparability[axis.status]
    if (status !== "unknown" && status !== "mismatch") continue
    failures.push({
      kind: status === "unknown" ? axis.unverifiedKind : axis.mismatchKind,
      message: status === "unknown" ? axis.unverifiedMessage : axis.mismatchMessage,
      baseline: comparability[axis.baselineValue] ?? "unknown",
      candidate: comparability[axis.candidateValue] ?? "unknown",
    })
  }
  return failures
}

// ── Axis 3: case set ─────────────────────────────────────────────────────────

const caseSetFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] =>
  comparison.changes
    .filter(
      (change) => change.kind === "missing_in_candidate" || change.kind === "new_in_candidate",
    )
    .map((change) => ({
      kind: "case_set_mismatch" as const,
      message: `${change.caseId} is ${change.kind.replaceAll("_", " ")}`,
      caseId: change.caseId,
      bucket: change.bucket,
      severity: change.severity,
    }))

// ── Axis 4: harness errors ───────────────────────────────────────────────────

const errorCountFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] =>
  comparison.candidate.counts.error > comparison.baseline.counts.error
    ? [
        {
          kind: "error_count_increase",
          message: "candidate introduced additional harness errors",
          baseline: comparison.baseline.counts.error,
          candidate: comparison.candidate.counts.error,
        },
      ]
    : []

// ── Axis 5: suite-level metrics ──────────────────────────────────────────────

interface MetricGate {
  readonly metric: keyof GroundingMetricDeltaSet
  readonly direction: MetricDirection
  readonly kind: GroundingRegressionFailure["kind"]
  readonly message: string
}

const METRIC_GATES: readonly MetricGate[] = [
  {
    metric: "wrong_thread_rate",
    direction: "increase",
    kind: "wrong_thread_rate_increase",
    message: "wrong-thread rate increased",
  },
  {
    metric: "clarify_recall",
    direction: "decrease",
    kind: "clarify_recall_decrease",
    message: "clarify recall decreased",
  },
  {
    metric: "summary_equivalence_rate",
    direction: "decrease",
    kind: "summary_equivalence_rate_decrease",
    message: "summary equivalence decreased",
  },
  {
    metric: "thread_selection_accuracy",
    direction: "decrease",
    kind: "thread_selection_accuracy_decrease",
    message: "thread selection accuracy decreased",
  },
  {
    metric: "referent_accuracy",
    direction: "decrease",
    kind: "referent_accuracy_decrease",
    message: "referent accuracy decreased",
  },
  {
    metric: "exact_tuple_match_rate",
    direction: "decrease",
    kind: "exact_tuple_match_rate_decrease",
    message: "exact tuple match rate decreased",
  },
  {
    metric: "structured_output_validity",
    direction: "decrease",
    kind: "structured_output_validity_decrease",
    message: "structured output validity decreased",
  },
]

const metricFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] => {
  const metrics = comparison.metricDeltas
  const failures: GroundingRegressionFailure[] = []
  for (const gate of METRIC_GATES) {
    const metric = metrics[gate.metric]
    if (!regressed(metric.delta, gate.direction)) continue
    failures.push({
      kind: gate.kind,
      message: gate.message,
      baseline: metric.baseline,
      candidate: metric.candidate,
    })
  }
  return failures
}

// ── Axis 6: critical buckets ─────────────────────────────────────────────────
// Two metrics gate EVERY bucket that holds critical cases; on top of that each
// bucket has the one metric it exists to measure.

interface BucketMetricGate {
  readonly metric: keyof GroundingMetricDeltaSet
  readonly direction: MetricDirection
}

const UNIVERSAL_BUCKET_GATES: readonly BucketMetricGate[] = [
  { metric: "wrong_thread_rate", direction: "increase" },
  { metric: "exact_tuple_match_rate", direction: "decrease" },
]

/** The one metric a bucket exists to measure. */
const signatureGateOf = (bucket: GroundingBucket): BucketMetricGate => {
  switch (bucket) {
    case "must_clarify":
      return { metric: "clarify_recall", direction: "decrease" }
    case "summary_equivalence":
      return { metric: "summary_equivalence_rate", direction: "decrease" }
    case "stale_context_trap":
      return { metric: "stale_context_attachment_rate", direction: "increase" }
    default:
      return { metric: "referent_accuracy", direction: "decrease" }
  }
}

const criticalBucketFailure = (
  bucket: GroundingBucketDelta,
  gate: BucketMetricGate,
): GroundingRegressionFailure => ({
  kind: "critical_bucket_regression",
  message: `${bucket.bucket} critical bucket regressed on ${gate.metric}`,
  bucket: bucket.bucket,
  severity: bucket.baselineMaxSeverity ?? bucket.candidateMaxSeverity ?? "critical",
  baseline: bucket.metrics[gate.metric].baseline,
  candidate: bucket.metrics[gate.metric].candidate,
})

const criticalBucketFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] => {
  const failures: GroundingRegressionFailure[] = []
  for (const bucket of comparison.bucketDeltas) {
    if (Math.max(bucket.baselineCriticalCases, bucket.candidateCriticalCases) === 0) continue
    for (const gate of [...UNIVERSAL_BUCKET_GATES, signatureGateOf(bucket.bucket)]) {
      if (regressed(bucket.metrics[gate.metric].delta, gate.direction)) {
        failures.push(criticalBucketFailure(bucket, gate))
      }
    }
  }
  return failures
}

// ── Axis 7: per-case verdict regressions ─────────────────────────────────────

const caseRegressionFailures = (
  comparison: GroundingComparisonReport,
): readonly GroundingRegressionFailure[] =>
  comparison.regressions
    .filter((regression) => regression.kind === "regressed")
    .map((regression) => ({
      kind: "case_regression" as const,
      message: `${regression.caseId} regressed ${regression.baselineVerdict} -> ${regression.candidateVerdict}`,
      caseId: regression.caseId,
      bucket: regression.bucket,
      severity: regression.severity,
      baseline: regression.baselineVerdict ?? "unknown",
      candidate: regression.candidateVerdict ?? "unknown",
    }))

/**
 * The `strict` profile runs every axis, in this order. The order IS the
 * report's reading order (identity first, because a mismatch there makes the
 * metric deltas below meaningless).
 */
export const evaluateGroundingRegression = (
  comparison: GroundingComparisonReport,
  profile: GroundingRegressionProfile,
): readonly GroundingRegressionFailure[] => {
  switch (profile) {
    case "strict":
      return [
        ...identityAxisFailures(comparison),
        ...provenanceAxisFailures(comparison),
        ...caseSetFailures(comparison),
        ...errorCountFailures(comparison),
        ...metricFailures(comparison),
        ...criticalBucketFailures(comparison),
        ...caseRegressionFailures(comparison),
      ]
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

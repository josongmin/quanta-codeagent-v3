import type { EvalRecord, GroundingPayload, RunSummaryRecord } from "../storage"
import type { Verdict } from "../types"
import type { GroundingErrorKind } from "./diagnostics"
import { GROUNDING_BUCKETS, type GroundingBucket, type GroundingMode, type GroundingSeverity } from "./schema"

export interface GroundingMetrics {
  thread_selection_accuracy: number
  referent_accuracy: number
  intent_accuracy: number
  scope_accuracy: number
  clarify_precision: number
  clarify_recall: number
  wrong_thread_rate: number
  stale_context_attachment_rate: number
  summary_equivalence_rate: number
  exact_tuple_match_rate: number
  structured_output_validity: number
}

export interface GroundingNormalizationLift {
  thread_selection_accuracy: number
  referent_accuracy: number
  exact_tuple_match_rate: number
}

export interface GroundingBucketReport {
  bucket: GroundingBucket
  total: number
  maxSeverity: GroundingSeverity
  criticalCases: number
  counts: Record<Verdict, number>
  metrics: GroundingMetrics
  rawMetrics?: GroundingMetrics
}

export interface GroundingReport {
  runId: string
  suite?: string
  corpus?: string
  mode?: GroundingMode
  probeProfile?: string
  normalizationProfile?: string
  structuredOutputProtocol?: string
  total: number
  counts: Record<Verdict, number>
  route: {
    provider?: string
    model?: string
    surfaceId?: string
    transportId?: string
    authMode?: string
  }
  run?: {
    durationMs?: number
    status?: RunSummaryRecord["status"]
    params?: RunSummaryRecord["params"]
  }
  errorKinds: Readonly<Record<string, number>>
  metrics: GroundingMetrics
  rawMetrics?: GroundingMetrics
  normalizationLift: GroundingNormalizationLift
  buckets: readonly GroundingBucketReport[]
  payloads: readonly GroundingPayload[]
}

export interface GroundingReportOutput {
  headline: string
  markdown: string
  report: GroundingReport
}

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

export const isGroundingGateProfile = (value: string): value is GroundingGateProfile =>
  GROUNDING_GATE_PROFILES.includes(value as GroundingGateProfile)

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

const rate = (num: number, denom: number): number => (denom === 0 ? 0 : num / denom)
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const severityRank: Record<GroundingSeverity, number> = {
  medium: 1,
  high: 2,
  critical: 3,
}

const actualTuple = (payload: GroundingPayload, which: "scored" | "raw"): string | null => {
  const actual =
    which === "raw"
      ? payload.rawActual
      : payload.scoredActual ?? payload.actual
  return actual === undefined
    ? null
    : JSON.stringify({
        activeThreadId: actual.activeThreadId,
        referentId: actual.referentId,
        intent: actual.intent,
        scope: actual.scope,
        shouldClarify: actual.shouldClarify,
      })
}

const computeMatches = (
  payload: GroundingPayload,
  which: "scored" | "raw",
): GroundingPayload["matches"] => {
  if (which === "scored") return payload.matches
  const actual = payload.rawActual
  if (actual === undefined) {
    return {
      activeThread: false,
      referent: false,
      intent: false,
      scope: false,
      shouldClarify: false,
      exactTuple: false,
      wrongThread: false,
      mustClarifyMiss: false,
      staleContextTrapMiss: false,
    }
  }
  const activeThread = actual.activeThreadId === payload.gold.activeThreadId
  const referent = actual.referentId === payload.gold.referentId
  const intent = actual.intent === payload.gold.intent
  const scope = actual.scope === payload.gold.scope
  const shouldClarify = actual.shouldClarify === payload.gold.shouldClarify
  const exactTuple = activeThread && referent && intent && scope && shouldClarify
  const wrongThread = !activeThread
  const mustClarifyMiss = payload.bucket === "must_clarify" && actual.shouldClarify !== true
  const staleContextTrapMiss =
    payload.bucket === "stale_context_trap" && (!activeThread || !referent)
  return {
    activeThread,
    referent,
    intent,
    scope,
    shouldClarify,
    exactTuple,
    wrongThread,
    mustClarifyMiss,
    staleContextTrapMiss,
  }
}

const filterGroundingRecords = (
  records: Iterable<EvalRecord>,
  runId: string,
): readonly GroundingPayload[] => {
  const out: GroundingPayload[] = []
  for (const record of records) {
    if (record.runId !== runId) continue
    if (record.payload.kind !== "grounding") continue
    out.push(record.payload)
  }
  return out
}

const countVerdicts = (payloads: readonly GroundingPayload[]): Record<Verdict, number> => {
  const counts = emptyCounts()
  for (const payload of payloads) counts[payload.verdict] += 1
  return counts
}

const buildGroundingMetricsWithSource = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): GroundingMetrics => {
  const total = payloads.length
  if (total === 0) return emptyMetrics()
  let threadOk = 0
  let referentOk = 0
  let intentOk = 0
  let scopeOk = 0
  let exactOk = 0
  let wrongThread = 0
  let staleMiss = 0
  let clarifyTp = 0
  let clarifyFp = 0
  let clarifyFn = 0
  let staleDenom = 0
  let structuredOutputOk = 0
  const pairMap = new Map<string, Map<string, GroundingPayload>>()
  for (const payload of payloads) {
    const matches = computeMatches(payload, which)
    if (matches.activeThread) threadOk += 1
    if (matches.referent) referentOk += 1
    if (matches.intent) intentOk += 1
    if (matches.scope) scopeOk += 1
    if (matches.exactTuple) exactOk += 1
    if (matches.wrongThread) wrongThread += 1
    if (payload.structuredOutputValid === true) structuredOutputOk += 1
    if (payload.bucket === "stale_context_trap") {
      staleDenom += 1
      if (matches.staleContextTrapMiss) staleMiss += 1
    }
    const actual = which === "raw" ? payload.rawActual : payload.scoredActual ?? payload.actual
    const predictedClarify = actual?.shouldClarify === true
    const goldClarify = payload.gold.shouldClarify === true
    if (predictedClarify && goldClarify) clarifyTp += 1
    if (predictedClarify && !goldClarify) clarifyFp += 1
    if (!predictedClarify && goldClarify) clarifyFn += 1
    if (payload.pairId !== undefined && payload.pairRole !== undefined) {
      const slots = pairMap.get(payload.pairId) ?? new Map<string, GroundingPayload>()
      slots.set(payload.pairRole, payload)
      pairMap.set(payload.pairId, slots)
    }
  }
  let summaryPairs = 0
  let summaryMatches = 0
  for (const slots of pairMap.values()) {
    summaryPairs += 1
    const raw = slots.get("raw")
    const summary = slots.get("summary")
    if (raw === undefined || summary === undefined) continue
    if (actualTuple(raw, which) !== null && actualTuple(raw, which) === actualTuple(summary, which)) {
      summaryMatches += 1
    }
  }
  return {
    thread_selection_accuracy: rate(threadOk, total),
    referent_accuracy: rate(referentOk, total),
    intent_accuracy: rate(intentOk, total),
    scope_accuracy: rate(scopeOk, total),
    clarify_precision: rate(clarifyTp, clarifyTp + clarifyFp),
    clarify_recall: rate(clarifyTp, clarifyTp + clarifyFn),
    wrong_thread_rate: rate(wrongThread, total),
    stale_context_attachment_rate: rate(staleMiss, staleDenom),
    summary_equivalence_rate: rate(summaryMatches, summaryPairs),
    exact_tuple_match_rate: rate(exactOk, total),
    structured_output_validity: rate(structuredOutputOk, total),
  }
}

export const buildGroundingMetrics = (
  payloads: readonly GroundingPayload[],
): GroundingMetrics => buildGroundingMetricsWithSource(payloads, "scored")

const buildNormalizationLift = (
  metrics: GroundingMetrics,
  rawMetrics: GroundingMetrics | undefined,
): GroundingNormalizationLift => ({
  thread_selection_accuracy:
    rawMetrics === undefined ? 0 : metrics.thread_selection_accuracy - rawMetrics.thread_selection_accuracy,
  referent_accuracy:
    rawMetrics === undefined ? 0 : metrics.referent_accuracy - rawMetrics.referent_accuracy,
  exact_tuple_match_rate:
    rawMetrics === undefined ? 0 : metrics.exact_tuple_match_rate - rawMetrics.exact_tuple_match_rate,
})

export const buildGroundingBucketReports = (
  payloads: readonly GroundingPayload[],
): readonly GroundingBucketReport[] => {
  const out: GroundingBucketReport[] = []
  for (const bucket of GROUNDING_BUCKETS) {
    const scoped = payloads.filter((payload) => payload.bucket === bucket)
    if (scoped.length === 0) continue
    let maxSeverity: GroundingSeverity = "medium"
    let criticalCases = 0
    for (const payload of scoped) {
      if (severityRank[payload.severity] > severityRank[maxSeverity]) maxSeverity = payload.severity
      if (payload.severity === "critical") criticalCases += 1
    }
    out.push({
      bucket,
      total: scoped.length,
      maxSeverity,
      criticalCases,
      counts: countVerdicts(scoped),
      metrics: buildGroundingMetricsWithSource(scoped, "scored"),
      rawMetrics: scoped.some((payload) => payload.rawActual !== undefined)
        ? buildGroundingMetricsWithSource(scoped, "raw")
        : undefined,
    })
  }
  return out
}

const buildErrorKinds = (
  payloads: readonly GroundingPayload[],
): Readonly<Record<GroundingErrorKind | "unknown", number>> => {
  const counts: Partial<Record<GroundingErrorKind | "unknown", number>> = {}
  for (const payload of payloads) {
    if (payload.errorKind === undefined) continue
    counts[payload.errorKind] = (counts[payload.errorKind] ?? 0) + 1
  }
  return counts as Readonly<Record<GroundingErrorKind | "unknown", number>>
}

const summaryParam = (summary: RunSummaryRecord | null | undefined, key: string): string | undefined => {
  const value = summary?.params?.[key]
  return typeof value === "string" ? value : undefined
}

const summaryRunView = (
  summary: RunSummaryRecord | null | undefined,
): GroundingReport["run"] | undefined => {
  if (summary === null || summary === undefined) return undefined
  return {
    durationMs: summary.durationMs,
    ...(summary.status !== undefined ? { status: summary.status } : {}),
    ...(summary.params !== undefined ? { params: summary.params } : {}),
  }
}

const reportRoute = (
  payloads: readonly GroundingPayload[],
  summary: RunSummaryRecord | null | undefined,
): GroundingReport["route"] => {
  const first = payloads[0]
  const provider = summaryParam(summary, "provider") ?? first?.provider
  const model = summaryParam(summary, "model") ?? first?.model
  const surfaceId = summaryParam(summary, "surfaceId") ?? first?.surfaceId
  const transportId = summaryParam(summary, "transportId") ?? first?.transportId
  const authMode = summaryParam(summary, "authMode") ?? first?.authMode
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(surfaceId !== undefined ? { surfaceId } : {}),
    ...(transportId !== undefined ? { transportId } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
  }
}

const renderMarkdown = (report: GroundingReport): string => {
  const lines: string[] = []
  lines.push(`# Grounding Report — ${report.runId}`)
  lines.push("")
  lines.push(`Corpus: ${report.corpus ?? "unknown"}`)
  if (report.suite !== undefined) lines.push(`Suite: ${report.suite}`)
  if (report.mode !== undefined) lines.push(`Mode: ${report.mode}`)
  if (report.probeProfile !== undefined) lines.push(`Probe profile: ${report.probeProfile}`)
  if (report.normalizationProfile !== undefined) {
    lines.push(`Normalization profile: ${report.normalizationProfile}`)
  }
  if (report.structuredOutputProtocol !== undefined) {
    lines.push(`Output protocol: ${report.structuredOutputProtocol}`)
  }
  const routeBits = [
    report.route.provider,
    report.route.model,
    report.route.surfaceId,
    report.route.transportId,
  ].filter((value): value is string => value !== undefined && value !== "")
  if (routeBits.length > 0) lines.push(`Route: ${routeBits.join(" / ")}`)
  if (report.route.authMode !== undefined) lines.push(`Auth: ${report.route.authMode}`)
  if (report.run?.status !== undefined) lines.push(`Status: ${report.run.status}`)
  if (report.run?.durationMs !== undefined) lines.push(`Duration: ${report.run.durationMs}ms`)
  if (report.run?.params !== undefined) {
    const parts = Object.entries(report.run.params).map(([key, value]) => `${key}=${String(value)}`)
    if (parts.length > 0) lines.push(`Params: ${parts.join(", ")}`)
  }
  lines.push(`Cases: ${report.total}`)
  lines.push(
    `Verdicts: PASS=${report.counts.pass} PARTIAL=${report.counts.partial} FAIL=${report.counts.fail} ERR=${report.counts.error}`,
  )
  if (Object.keys(report.errorKinds).length > 0) {
    lines.push(`Errors: ${Object.entries(report.errorKinds).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  }
  lines.push("")
  lines.push("## Metrics")
  lines.push("")
  lines.push(`- thread_selection_accuracy: ${pct(report.metrics.thread_selection_accuracy)}`)
  lines.push(`- referent_accuracy: ${pct(report.metrics.referent_accuracy)}`)
  lines.push(`- intent_accuracy: ${pct(report.metrics.intent_accuracy)}`)
  lines.push(`- scope_accuracy: ${pct(report.metrics.scope_accuracy)}`)
  lines.push(`- clarify_precision: ${pct(report.metrics.clarify_precision)}`)
  lines.push(`- clarify_recall: ${pct(report.metrics.clarify_recall)}`)
  lines.push(`- wrong_thread_rate: ${pct(report.metrics.wrong_thread_rate)}`)
  lines.push(`- stale_context_attachment_rate: ${pct(report.metrics.stale_context_attachment_rate)}`)
  lines.push(`- summary_equivalence_rate: ${pct(report.metrics.summary_equivalence_rate)}`)
  lines.push(`- exact_tuple_match_rate: ${pct(report.metrics.exact_tuple_match_rate)}`)
  lines.push(`- structured_output_validity: ${pct(report.metrics.structured_output_validity)}`)
  if (report.rawMetrics !== undefined) {
    lines.push("")
    lines.push("## Raw Metrics")
    lines.push("")
    lines.push(`- thread_selection_accuracy: ${pct(report.rawMetrics.thread_selection_accuracy)}`)
    lines.push(`- referent_accuracy: ${pct(report.rawMetrics.referent_accuracy)}`)
    lines.push(`- exact_tuple_match_rate: ${pct(report.rawMetrics.exact_tuple_match_rate)}`)
    lines.push(`- structured_output_validity: ${pct(report.rawMetrics.structured_output_validity)}`)
    lines.push("")
    lines.push("## Normalization Lift")
    lines.push("")
    lines.push(`- thread_selection_accuracy: ${pct(report.normalizationLift.thread_selection_accuracy)}`)
    lines.push(`- referent_accuracy: ${pct(report.normalizationLift.referent_accuracy)}`)
    lines.push(`- exact_tuple_match_rate: ${pct(report.normalizationLift.exact_tuple_match_rate)}`)
  }
  lines.push("")
  lines.push("## Buckets")
  lines.push("")
  lines.push(
    "| Bucket | Cases | Max Sev | Critical | PASS | PARTIAL | FAIL | ERR | Exact | Wrong-thread | Referent | Clarify Recall | Struct Out |",
  )
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
  for (const bucket of report.buckets) {
    lines.push(
      `| ${bucket.bucket} | ${bucket.total} | ${bucket.maxSeverity} | ${bucket.criticalCases} | ${bucket.counts.pass} | ${bucket.counts.partial} | ${bucket.counts.fail} | ${bucket.counts.error} | ${pct(bucket.metrics.exact_tuple_match_rate)} | ${pct(bucket.metrics.wrong_thread_rate)} | ${pct(bucket.metrics.referent_accuracy)} | ${pct(bucket.metrics.clarify_recall)} | ${pct(bucket.metrics.structured_output_validity)} |`,
    )
  }
  lines.push("")
  lines.push("## Cases")
  lines.push("")
  lines.push(
    "| Case | Verdict | Bucket | Severity | Thread | Referent | Intent | Scope | Clarify | Struct Out | Error |",
  )
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|")
  for (const payload of report.payloads) {
    lines.push(
      `| \`${payload.caseId}\` | ${payload.verdict.toUpperCase()} | ${payload.bucket} | ${payload.severity} | ${payload.matches.activeThread ? "OK" : "MISS"} | ${payload.matches.referent ? "OK" : "MISS"} | ${payload.matches.intent ? "OK" : "MISS"} | ${payload.matches.scope ? "OK" : "MISS"} | ${payload.matches.shouldClarify ? "OK" : "MISS"} | ${payload.structuredOutputValid === true ? "OK" : "MISS"} | ${payload.errorKind ?? "-"} |`,
    )
  }
  return lines.join("\n")
}

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

export const evaluateGroundingGate = (
  report: GroundingReport,
  profile: GroundingGateProfile,
): readonly GroundingGateFailure[] => {
  if (report.mode === "assisted") return []
  switch (profile) {
    case "canary": {
      const failures: GroundingGateFailure[] = []
      if (report.counts.error > 0) {
        failures.push({ metric: "error_count", expected: "== 0", actual: report.counts.error })
      }
      const metrics = report.metrics
      if (metrics.wrong_thread_rate !== CANARY_THRESHOLDS.wrong_thread_rate) {
        failures.push({ metric: "wrong_thread_rate", expected: "== 0", actual: metrics.wrong_thread_rate })
      }
      if (metrics.clarify_recall !== CANARY_THRESHOLDS.clarify_recall) {
        failures.push({ metric: "clarify_recall", expected: "== 1.0", actual: metrics.clarify_recall })
      }
      if (metrics.summary_equivalence_rate !== CANARY_THRESHOLDS.summary_equivalence_rate) {
        failures.push({
          metric: "summary_equivalence_rate",
          expected: "== 1.0",
          actual: metrics.summary_equivalence_rate,
        })
      }
      if (metrics.thread_selection_accuracy < CANARY_THRESHOLDS.thread_selection_accuracy) {
        failures.push({
          metric: "thread_selection_accuracy",
          expected: ">= 0.97",
          actual: metrics.thread_selection_accuracy,
        })
      }
      if (metrics.referent_accuracy < CANARY_THRESHOLDS.referent_accuracy) {
        failures.push({
          metric: "referent_accuracy",
          expected: ">= 0.95",
          actual: metrics.referent_accuracy,
        })
      }
      if (metrics.exact_tuple_match_rate < CANARY_THRESHOLDS.exact_tuple_match_rate) {
        failures.push({
          metric: "exact_tuple_match_rate",
          expected: ">= 0.90",
          actual: metrics.exact_tuple_match_rate,
        })
      }
      if (metrics.structured_output_validity !== CANARY_THRESHOLDS.structured_output_validity) {
        failures.push({
          metric: "structured_output_validity",
          expected: "== 1.0",
          actual: metrics.structured_output_validity,
        })
      }
      const mustClarify = bucketById(report, "must_clarify")
      if (
        mustClarify !== undefined &&
        mustClarify.criticalCases > 0 &&
        mustClarify.metrics.clarify_recall !== 1
      ) {
        failures.push({
          metric: "must_clarify_bucket_clarify_recall",
          expected: "== 1.0",
          actual: mustClarify.metrics.clarify_recall,
        })
      }
      const staleTrap = bucketById(report, "stale_context_trap")
      if (
        staleTrap !== undefined &&
        staleTrap.criticalCases > 0 &&
        staleTrap.metrics.stale_context_attachment_rate !== 0
      ) {
        failures.push({
          metric: "stale_context_trap_bucket_attachment_rate",
          expected: "== 0",
          actual: staleTrap.metrics.stale_context_attachment_rate,
        })
      }
      const summaryEquivalence = bucketById(report, "summary_equivalence")
      if (
        summaryEquivalence !== undefined &&
        summaryEquivalence.criticalCases > 0 &&
        summaryEquivalence.metrics.summary_equivalence_rate !== 1
      ) {
        failures.push({
          metric: "summary_equivalence_bucket_rate",
          expected: "== 1.0",
          actual: summaryEquivalence.metrics.summary_equivalence_rate,
        })
      }
      const wrongThreadAdversarial = bucketById(report, "wrong_thread_adversarial")
      if (
        wrongThreadAdversarial !== undefined &&
        wrongThreadAdversarial.criticalCases > 0 &&
        wrongThreadAdversarial.metrics.wrong_thread_rate !== 0
      ) {
        failures.push({
          metric: "wrong_thread_adversarial_bucket_wrong_thread_rate",
          expected: "== 0",
          actual: wrongThreadAdversarial.metrics.wrong_thread_rate,
        })
      }
      return failures
    }
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

export const buildGroundingReport = (
  records: Iterable<EvalRecord>,
  runId: string,
  summary: RunSummaryRecord | null | undefined,
): GroundingReportOutput => {
  const payloads = filterGroundingRecords(records, runId)
  const counts = countVerdicts(payloads)
  const metrics = buildGroundingMetricsWithSource(payloads, "scored")
  const rawMetrics = payloads.some((payload) => payload.rawActual !== undefined)
    ? buildGroundingMetricsWithSource(payloads, "raw")
    : undefined
  const report: GroundingReport = {
    runId,
    ...(summaryParam(summary, "suite") !== undefined ? { suite: summaryParam(summary, "suite") } : {}),
    ...(summaryParam(summary, "corpus") !== undefined ? { corpus: summaryParam(summary, "corpus") } : {}),
    ...(summaryParam(summary, "mode") !== undefined ? { mode: summaryParam(summary, "mode") as GroundingMode } : {}),
    ...(summaryParam(summary, "probeProfile") !== undefined
      ? { probeProfile: summaryParam(summary, "probeProfile") }
      : {}),
    ...(summaryParam(summary, "normalizationProfile") !== undefined
      ? { normalizationProfile: summaryParam(summary, "normalizationProfile") }
      : {}),
    ...(summaryParam(summary, "outputProtocol") !== undefined
      ? { structuredOutputProtocol: summaryParam(summary, "outputProtocol") }
      : {}),
    total: payloads.length,
    counts,
    route: reportRoute(payloads, summary),
    run: summaryRunView(summary),
    errorKinds: buildErrorKinds(payloads),
    metrics,
    ...(rawMetrics !== undefined ? { rawMetrics } : {}),
    normalizationLift: buildNormalizationLift(metrics, rawMetrics),
    buckets: buildGroundingBucketReports(payloads),
    payloads,
  }
  return {
    headline: `PASS=${counts.pass} PARTIAL=${counts.partial} FAIL=${counts.fail} ERR=${counts.error} exact=${pct(metrics.exact_tuple_match_rate)} wrong-thread=${pct(metrics.wrong_thread_rate)} mode=${report.mode ?? "unknown"}`,
    markdown: renderMarkdown(report),
    report,
  }
}

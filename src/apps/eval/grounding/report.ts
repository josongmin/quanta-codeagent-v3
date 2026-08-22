import type { EvalRecord, GroundingPayload, RunSummaryRecord } from "../storage"
import type { Verdict } from "../types"
import type { GroundingErrorKind } from "./diagnostics"
import {
  GROUNDING_BUCKETS,
  type GroundingBucket,
  type GroundingMode,
  type GroundingSeverity,
} from "./schema"

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
  executionContractFingerprint?: string
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
  const actual = which === "raw" ? payload.rawActual : (payload.scoredActual ?? payload.actual)
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

/** How often each decision FIELD matched gold, across every payload. */
interface FieldMatchTally {
  readonly threadOk: number
  readonly referentOk: number
  readonly intentOk: number
  readonly scopeOk: number
  readonly exactOk: number
  readonly wrongThread: number
}

const fieldMatchTally = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): FieldMatchTally => {
  let threadOk = 0
  let referentOk = 0
  let intentOk = 0
  let scopeOk = 0
  let exactOk = 0
  let wrongThread = 0
  for (const payload of payloads) {
    const matches = computeMatches(payload, which)
    if (matches.activeThread) threadOk += 1
    if (matches.referent) referentOk += 1
    if (matches.intent) intentOk += 1
    if (matches.scope) scopeOk += 1
    if (matches.exactTuple) exactOk += 1
    if (matches.wrongThread) wrongThread += 1
  }
  return { threadOk, referentOk, intentOk, scopeOk, exactOk, wrongThread }
}

/** The stale-context-trap bucket scores against its OWN denominator: only trap
 *  cases can attach stale context, so the whole-suite total would dilute it. */
const staleTrapTally = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): { readonly denom: number; readonly miss: number } => {
  let denom = 0
  let miss = 0
  for (const payload of payloads) {
    if (payload.bucket !== "stale_context_trap") continue
    denom += 1
    if (computeMatches(payload, which).staleContextTrapMiss) miss += 1
  }
  return { denom, miss }
}

const structuredOutputOkCount = (payloads: readonly GroundingPayload[]): number =>
  payloads.filter((payload) => payload.structuredOutputValid === true).length

/** Clarify precision/recall confusion counts (true-positive / false-positive /
 *  false-negative against the gold `shouldClarify`). */
interface ClarifyTally {
  readonly tp: number
  readonly fp: number
  readonly fn: number
}

const clarifyTally = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): ClarifyTally => {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const payload of payloads) {
    const actual = which === "raw" ? payload.rawActual : (payload.scoredActual ?? payload.actual)
    const predictedClarify = actual?.shouldClarify === true
    const goldClarify = payload.gold.shouldClarify === true
    if (predictedClarify && goldClarify) tp += 1
    if (predictedClarify && !goldClarify) fp += 1
    if (!predictedClarify && goldClarify) fn += 1
  }
  return { tp, fp, fn }
}

/** Summary equivalence: a raw/summary PAIR agrees when both sides produced the
 *  same decision tuple. Pairs missing a side count toward the denominator but
 *  can never match — an unpaired half is not evidence of equivalence. */
const summaryEquivalenceTally = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): { readonly pairs: number; readonly matches: number } => {
  const pairMap = new Map<string, Map<string, GroundingPayload>>()
  for (const payload of payloads) {
    if (payload.pairId === undefined || payload.pairRole === undefined) continue
    const slots = pairMap.get(payload.pairId) ?? new Map<string, GroundingPayload>()
    slots.set(payload.pairRole, payload)
    pairMap.set(payload.pairId, slots)
  }
  let pairs = 0
  let matches = 0
  for (const slots of pairMap.values()) {
    pairs += 1
    const raw = slots.get("raw")
    const summary = slots.get("summary")
    if (raw === undefined || summary === undefined) continue
    if (
      actualTuple(raw, which) !== null &&
      actualTuple(raw, which) === actualTuple(summary, which)
    ) {
      matches += 1
    }
  }
  return { pairs, matches }
}

const buildGroundingMetricsWithSource = (
  payloads: readonly GroundingPayload[],
  which: "scored" | "raw",
): GroundingMetrics => {
  const total = payloads.length
  if (total === 0) return emptyMetrics()
  const fields = fieldMatchTally(payloads, which)
  const clarify = clarifyTally(payloads, which)
  const stale = staleTrapTally(payloads, which)
  const summary = summaryEquivalenceTally(payloads, which)
  return {
    thread_selection_accuracy: rate(fields.threadOk, total),
    referent_accuracy: rate(fields.referentOk, total),
    intent_accuracy: rate(fields.intentOk, total),
    scope_accuracy: rate(fields.scopeOk, total),
    clarify_precision: rate(clarify.tp, clarify.tp + clarify.fp),
    clarify_recall: rate(clarify.tp, clarify.tp + clarify.fn),
    wrong_thread_rate: rate(fields.wrongThread, total),
    stale_context_attachment_rate: rate(stale.miss, stale.denom),
    summary_equivalence_rate: rate(summary.matches, summary.pairs),
    exact_tuple_match_rate: rate(fields.exactOk, total),
    structured_output_validity: rate(structuredOutputOkCount(payloads), total),
  }
}

export const buildGroundingMetrics = (payloads: readonly GroundingPayload[]): GroundingMetrics =>
  buildGroundingMetricsWithSource(payloads, "scored")

const buildNormalizationLift = (
  metrics: GroundingMetrics,
  rawMetrics: GroundingMetrics | undefined,
): GroundingNormalizationLift => ({
  thread_selection_accuracy:
    rawMetrics === undefined
      ? 0
      : metrics.thread_selection_accuracy - rawMetrics.thread_selection_accuracy,
  referent_accuracy:
    rawMetrics === undefined ? 0 : metrics.referent_accuracy - rawMetrics.referent_accuracy,
  exact_tuple_match_rate:
    rawMetrics === undefined
      ? 0
      : metrics.exact_tuple_match_rate - rawMetrics.exact_tuple_match_rate,
})

/** Worst severity present in the bucket, and how many of its cases are critical. */
const severitySummary = (
  scoped: readonly GroundingPayload[],
): { readonly maxSeverity: GroundingSeverity; readonly criticalCases: number } => {
  let maxSeverity: GroundingSeverity = "medium"
  let criticalCases = 0
  for (const payload of scoped) {
    if (severityRank[payload.severity] > severityRank[maxSeverity]) maxSeverity = payload.severity
    if (payload.severity === "critical") criticalCases += 1
  }
  return { maxSeverity, criticalCases }
}

/**
 * `summary_equivalence` is the one bucket whose METRIC set is not the bucket's
 * own cases: equivalence is a property of a raw/summary PAIR, so scoring it
 * needs both halves even when only one half sits in this bucket.
 */
const summaryPairClosure = (
  payloads: readonly GroundingPayload[],
  scoped: readonly GroundingPayload[],
): readonly GroundingPayload[] => {
  const pairIds = new Set(
    scoped
      .map((payload) => payload.pairId)
      .filter((pairId): pairId is string => typeof pairId === "string" && pairId !== ""),
  )
  if (pairIds.size === 0) return scoped
  return payloads.filter((payload) => payload.pairId !== undefined && pairIds.has(payload.pairId))
}

const bucketReport = (
  bucket: GroundingBucket,
  scoped: readonly GroundingPayload[],
  metricPayloads: readonly GroundingPayload[],
): GroundingBucketReport => {
  const rawMetrics = metricPayloads.some((payload) => payload.rawActual !== undefined)
    ? buildGroundingMetricsWithSource(metricPayloads, "raw")
    : undefined
  const severity = severitySummary(scoped)
  return {
    bucket,
    total: scoped.length,
    maxSeverity: severity.maxSeverity,
    criticalCases: severity.criticalCases,
    counts: countVerdicts(scoped),
    metrics: buildGroundingMetricsWithSource(metricPayloads, "scored"),
    ...(rawMetrics !== undefined ? { rawMetrics } : {}),
  }
}

export const buildGroundingBucketReports = (
  payloads: readonly GroundingPayload[],
): readonly GroundingBucketReport[] => {
  const out: GroundingBucketReport[] = []
  for (const bucket of GROUNDING_BUCKETS) {
    const scoped = payloads.filter((payload) => payload.bucket === bucket)
    if (scoped.length === 0) continue
    const metricPayloads =
      bucket === "summary_equivalence" ? summaryPairClosure(payloads, scoped) : scoped
    out.push(bucketReport(bucket, scoped, metricPayloads))
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

const summaryParam = (
  summary: RunSummaryRecord | null | undefined,
  key: string,
): string | undefined => {
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

/** Run identity + route + verdict counts — everything above the first section. */
const renderReportPreamble = (report: GroundingReport): readonly string[] => {
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
  if (report.executionContractFingerprint !== undefined) {
    lines.push(`Execution contract: ${report.executionContractFingerprint}`)
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
    lines.push(
      `Errors: ${Object.entries(report.errorKinds)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    )
  }
  return lines
}

/** The eleven suite-level metrics. */
const renderMetricsSection = (metrics: GroundingMetrics): readonly string[] => [
  "",
  "## Metrics",
  "",
  `- thread_selection_accuracy: ${pct(metrics.thread_selection_accuracy)}`,
  `- referent_accuracy: ${pct(metrics.referent_accuracy)}`,
  `- intent_accuracy: ${pct(metrics.intent_accuracy)}`,
  `- scope_accuracy: ${pct(metrics.scope_accuracy)}`,
  `- clarify_precision: ${pct(metrics.clarify_precision)}`,
  `- clarify_recall: ${pct(metrics.clarify_recall)}`,
  `- wrong_thread_rate: ${pct(metrics.wrong_thread_rate)}`,
  `- stale_context_attachment_rate: ${pct(metrics.stale_context_attachment_rate)}`,
  `- summary_equivalence_rate: ${pct(metrics.summary_equivalence_rate)}`,
  `- exact_tuple_match_rate: ${pct(metrics.exact_tuple_match_rate)}`,
  `- structured_output_validity: ${pct(metrics.structured_output_validity)}`,
]

/** Pre-normalization metrics + the lift normalization bought — only meaningful
 *  when the run actually recorded raw decisions. */
const renderNormalizationSections = (report: GroundingReport): readonly string[] => {
  const rawMetrics = report.rawMetrics
  if (rawMetrics === undefined) return []
  return [
    "",
    "## Raw Metrics",
    "",
    `- thread_selection_accuracy: ${pct(rawMetrics.thread_selection_accuracy)}`,
    `- referent_accuracy: ${pct(rawMetrics.referent_accuracy)}`,
    `- exact_tuple_match_rate: ${pct(rawMetrics.exact_tuple_match_rate)}`,
    `- structured_output_validity: ${pct(rawMetrics.structured_output_validity)}`,
    "",
    "## Normalization Lift",
    "",
    `- thread_selection_accuracy: ${pct(report.normalizationLift.thread_selection_accuracy)}`,
    `- referent_accuracy: ${pct(report.normalizationLift.referent_accuracy)}`,
    `- exact_tuple_match_rate: ${pct(report.normalizationLift.exact_tuple_match_rate)}`,
  ]
}

const renderBucketTable = (buckets: readonly GroundingBucketReport[]): readonly string[] => [
  "",
  "## Buckets",
  "",
  "| Bucket | Cases | Max Sev | Critical | PASS | PARTIAL | FAIL | ERR | Exact | Wrong-thread | Referent | Clarify Recall | Struct Out |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...buckets.map(
    (bucket) =>
      `| ${bucket.bucket} | ${bucket.total} | ${bucket.maxSeverity} | ${bucket.criticalCases} | ${bucket.counts.pass} | ${bucket.counts.partial} | ${bucket.counts.fail} | ${bucket.counts.error} | ${pct(bucket.metrics.exact_tuple_match_rate)} | ${pct(bucket.metrics.wrong_thread_rate)} | ${pct(bucket.metrics.referent_accuracy)} | ${pct(bucket.metrics.clarify_recall)} | ${pct(bucket.metrics.structured_output_validity)} |`,
  ),
]

const renderCaseTable = (payloads: readonly GroundingPayload[]): readonly string[] => [
  "",
  "## Cases",
  "",
  "| Case | Verdict | Bucket | Severity | Thread | Referent | Intent | Scope | Clarify | Struct Out | Error |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...payloads.map(
    (payload) =>
      `| \`${payload.caseId}\` | ${payload.verdict.toUpperCase()} | ${payload.bucket} | ${payload.severity} | ${payload.matches.activeThread ? "OK" : "MISS"} | ${payload.matches.referent ? "OK" : "MISS"} | ${payload.matches.intent ? "OK" : "MISS"} | ${payload.matches.scope ? "OK" : "MISS"} | ${payload.matches.shouldClarify ? "OK" : "MISS"} | ${payload.structuredOutputValid === true ? "OK" : "MISS"} | ${payload.errorKind ?? "-"} |`,
  ),
]

const renderMarkdown = (report: GroundingReport): string =>
  [
    ...renderReportPreamble(report),
    ...renderMetricsSection(report.metrics),
    ...renderNormalizationSections(report),
    ...renderBucketTable(report.buckets),
    ...renderCaseTable(report.payloads),
  ].join("\n")

export const buildGroundingReport = (
  records: Iterable<EvalRecord>,
  runId: string,
  summary?: RunSummaryRecord | null,
): GroundingReportOutput => {
  const payloads = filterGroundingRecords(records, runId)
  const counts = countVerdicts(payloads)
  const metrics = buildGroundingMetricsWithSource(payloads, "scored")
  const rawMetrics = payloads.some((payload) => payload.rawActual !== undefined)
    ? buildGroundingMetricsWithSource(payloads, "raw")
    : undefined
  const suite = summaryParam(summary, "suite")
  const corpus = summaryParam(summary, "corpus")
  const mode = summaryParam(summary, "mode")
  const probeProfile = summaryParam(summary, "probeProfile")
  const normalizationProfile = summaryParam(summary, "normalizationProfile")
  const outputProtocol = summaryParam(summary, "outputProtocol")
  const executionContractFingerprint = summaryParam(summary, "executionContractFingerprint")
  const run = summaryRunView(summary)
  const report: GroundingReport = {
    runId,
    ...(suite !== undefined ? { suite } : {}),
    ...(corpus !== undefined ? { corpus } : {}),
    ...(mode !== undefined ? { mode: mode as GroundingMode } : {}),
    ...(probeProfile !== undefined ? { probeProfile } : {}),
    ...(normalizationProfile !== undefined ? { normalizationProfile } : {}),
    ...(outputProtocol !== undefined ? { structuredOutputProtocol: outputProtocol } : {}),
    ...(executionContractFingerprint !== undefined ? { executionContractFingerprint } : {}),
    total: payloads.length,
    counts,
    route: reportRoute(payloads, summary),
    ...(run !== undefined ? { run } : {}),
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

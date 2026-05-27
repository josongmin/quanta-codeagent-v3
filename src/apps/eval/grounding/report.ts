import type { EvalRecord, GroundingPayload } from "../storage"
import type { GroundingErrorKind } from "./diagnostics"
import type { Verdict } from "../types"

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
}

export interface GroundingReport {
  runId: string
  suite?: string
  total: number
  counts: Record<Verdict, number>
  route: {
    provider?: string
    model?: string
    surfaceId?: string
    transportId?: string
    authMode?: string
  }
  errorKinds: Readonly<Record<string, number>>
  metrics: GroundingMetrics
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
  expected: string
  actual: number
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

const rate = (num: number, denom: number): number => (denom === 0 ? 0 : num / denom)

const actualTuple = (payload: GroundingPayload): string | null =>
  payload.actual === undefined
    ? null
    : JSON.stringify({
        activeThreadId: payload.actual.activeThreadId,
        referentId: payload.actual.referentId,
        intent: payload.actual.intent,
        scope: payload.actual.scope,
        shouldClarify: payload.actual.shouldClarify,
      })

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

const buildMetrics = (payloads: readonly GroundingPayload[]): GroundingMetrics => {
  const total = payloads.length
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
  const pairMap = new Map<string, Map<string, GroundingPayload>>()
  for (const payload of payloads) {
    if (payload.matches.activeThread) threadOk += 1
    if (payload.matches.referent) referentOk += 1
    if (payload.matches.intent) intentOk += 1
    if (payload.matches.scope) scopeOk += 1
    if (payload.matches.exactTuple) exactOk += 1
    if (payload.matches.wrongThread) wrongThread += 1
    if (payload.bucket === "stale_context_trap") {
      staleDenom += 1
      if (payload.matches.staleContextTrapMiss) staleMiss += 1
    }
    const predictedClarify = payload.actual?.shouldClarify === true
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
    if (actualTuple(raw) !== null && actualTuple(raw) === actualTuple(summary)) summaryMatches += 1
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
  }
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

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

const renderMarkdown = (report: GroundingReport): string => {
  const lines: string[] = []
  lines.push(`# Grounding Report — ${report.runId}`)
  lines.push("")
  lines.push(`Suite: ${report.suite ?? "unknown"}`)
  const routeBits = [
    report.route.provider,
    report.route.model,
    report.route.surfaceId,
    report.route.transportId,
  ].filter((value): value is string => value !== undefined && value !== "")
  if (routeBits.length > 0) lines.push(`Route: ${routeBits.join(" / ")}`)
  if (report.route.authMode !== undefined) lines.push(`Auth: ${report.route.authMode}`)
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
  lines.push(
    `- stale_context_attachment_rate: ${pct(report.metrics.stale_context_attachment_rate)}`,
  )
  lines.push(`- summary_equivalence_rate: ${pct(report.metrics.summary_equivalence_rate)}`)
  lines.push(`- exact_tuple_match_rate: ${pct(report.metrics.exact_tuple_match_rate)}`)
  lines.push("")
  lines.push("## Cases")
  lines.push("")
  lines.push("| Case | Verdict | Bucket | Severity | Thread | Referent | Intent | Scope | Clarify |")
  lines.push("|---|---|---|---|---|---|---|---|---|")
  for (const payload of report.payloads) {
    lines.push(
      `| \`${payload.caseId}\` | ${payload.verdict.toUpperCase()} | ${payload.bucket} | ${payload.severity} | ${payload.matches.activeThread ? "OK" : "MISS"} | ${payload.matches.referent ? "OK" : "MISS"} | ${payload.matches.intent ? "OK" : "MISS"} | ${payload.matches.scope ? "OK" : "MISS"} | ${payload.matches.shouldClarify ? "OK" : "MISS"} |`,
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
} as const

export const evaluateGroundingGate = (
  report: GroundingReport,
  profile: GroundingGateProfile,
): readonly GroundingGateFailure[] => {
  switch (profile) {
    case "canary": {
      const failures: GroundingGateFailure[] = []
      if (report.counts.error > 0) {
        failures.push({
          metric: "error_count",
          expected: "== 0",
          actual: report.counts.error,
        })
      }
      const metrics = report.metrics
      if (metrics.wrong_thread_rate !== CANARY_THRESHOLDS.wrong_thread_rate) {
        failures.push({
          metric: "wrong_thread_rate",
          expected: "== 0",
          actual: metrics.wrong_thread_rate,
        })
      }
      if (metrics.clarify_recall !== CANARY_THRESHOLDS.clarify_recall) {
        failures.push({
          metric: "clarify_recall",
          expected: "== 1.0",
          actual: metrics.clarify_recall,
        })
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
      return failures
    }
  }
}

export const buildGroundingReport = (
  records: Iterable<EvalRecord>,
  runId: string,
): GroundingReportOutput => {
  const payloads = filterGroundingRecords(records, runId)
  if (payloads.length === 0) {
    throw new Error(`no grounding records found for runId=${runId}`)
  }
  const counts = emptyCounts()
  for (const payload of payloads) counts[payload.verdict] += 1
  const suite = payloads[0]?.suite
  const first = payloads[0]
  const report: GroundingReport = {
    runId,
    ...(suite !== undefined ? { suite } : {}),
    total: payloads.length,
    counts,
    route: {
      ...(first?.provider !== undefined ? { provider: first.provider } : {}),
      ...(first?.model !== undefined ? { model: first.model } : {}),
      ...(first?.surfaceId !== undefined ? { surfaceId: first.surfaceId } : {}),
      ...(first?.transportId !== undefined ? { transportId: first.transportId } : {}),
      ...(first?.authMode !== undefined ? { authMode: first.authMode } : {}),
    },
    errorKinds: buildErrorKinds(payloads),
    metrics: buildMetrics(payloads),
    payloads,
  }
  const headline = `PASS=${counts.pass} PARTIAL=${counts.partial} FAIL=${counts.fail} ERR=${counts.error} exact=${pct(report.metrics.exact_tuple_match_rate)} wrong-thread=${pct(report.metrics.wrong_thread_rate)}`
  return {
    headline,
    markdown: renderMarkdown(report),
    report,
  }
}

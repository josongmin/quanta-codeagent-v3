import type { LLMPort } from "@/llm"
import { makeRunId, ResultStore, type GroundingPayload } from "../storage"
import type { Verdict } from "../types"
import type { GroundingErrorKind } from "./diagnostics"
import { classifyGroundingInfraError, classifyGroundingParserError, GROUNDING_ERROR_KINDS } from "./diagnostics"
import { loadGroundingCases, type LoadGroundingCasesOpts } from "./loader"
import {
  buildGroundingReport,
  evaluateGroundingGate,
  GROUNDING_GATE_PROFILES,
  isGroundingGateProfile,
  type GroundingGateFailure,
  type GroundingGateProfile,
  type GroundingReportOutput,
} from "./report"
import {
  runGroundingPreflight,
  runGroundingProbe,
  type GroundingPreflightResult,
} from "./probe"
import { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"
import type { GroundingCase, GroundingSuite } from "./schema"
import { parseGroundingCase } from "./schema"

export {
  buildGroundingReport,
  evaluateGroundingGate,
  GROUNDING_GATE_PROFILES,
  isGroundingGateProfile,
  type GroundingGateFailure,
  type GroundingGateProfile,
  type GroundingReportOutput,
} from "./report"
export {
  GROUNDING_BUCKETS,
  GROUNDING_CONFIDENCE,
  GROUNDING_INTENTS,
  GROUNDING_PAIR_ROLES,
  GROUNDING_SCHEMA_VERSION,
  GROUNDING_SCOPES,
  GROUNDING_SEVERITIES,
  GROUNDING_SUITES,
  GROUNDING_USECASE,
  parseGroundingCase,
  type GroundingBucket,
  type GroundingCase,
  type GroundingConfidence,
  type GroundingContextChange,
  type GroundingDecision,
  type GroundingIntent,
  type GroundingPairRole,
  type GroundingSeverity,
  type GroundingSuite,
} from "./schema"
export {
  GROUNDING_ERROR_KINDS,
  classifyGroundingInfraError,
  classifyGroundingParserError,
  type GroundingErrorKind,
} from "./diagnostics"
export { extractJsonObject, parseGroundingDecisionText } from "./parser"
export { loadGroundingCases } from "./loader"
export { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"
export {
  runGroundingPreflight,
  runGroundingProbe,
  type GroundingPreflightResult,
} from "./probe"

export interface GroundingRunOpts extends LoadGroundingCasesOpts {
  llm: LLMPort
  caseId?: string
  limit?: number
  concurrency?: number
  storeDir?: string
  now?: () => number
}

export interface GroundingRunRoute {
  provider?: string
  model?: string
  surfaceId?: string
  transportId?: string
  authMode?: string
}

export interface GroundingRunSummary extends GroundingRunRoute {
  runId: string
  suite: GroundingSuite
  total: number
  counts: Record<Verdict, number>
  durationMs: number
  concurrency: number
}

interface GroundingCaseExecution {
  verdict: Verdict
  payload: GroundingPayload
}

const emptyCounts = (): Record<Verdict, number> => ({
  pass: 0,
  partial: 0,
  fail: 0,
  error: 0,
  skipped: 0,
})

const llmRoute = (llm: LLMPort): GroundingRunRoute => ({
  ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
  ...(llm.model !== undefined ? { model: llm.model } : {}),
  ...(llm.surfaceId !== undefined ? { surfaceId: llm.surfaceId } : {}),
  ...(llm.transportId !== undefined ? { transportId: llm.transportId } : {}),
  ...(llm.authMode !== undefined ? { authMode: llm.authMode } : {}),
})

const executeGroundingCase = async (
  groundingCase: GroundingCase,
  opts: GroundingRunOpts,
): Promise<GroundingCaseExecution> => {
  const probe = await runGroundingProbe(groundingCase, {
    llm: opts.llm,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  let verdict: Verdict = "error"
  const matches = emptyGroundingMatches()
  if (probe.error === undefined && probe.decision !== undefined) {
    const scored = scoreGroundingDecision(groundingCase, probe.decision)
    verdict = scored.verdict
    Object.assign(matches, scored.matches)
  }
  const payload: GroundingPayload = {
    kind: "grounding",
    suite: opts.suite,
    caseId: groundingCase.id,
    verdict,
    bucket: groundingCase.bucket,
    severity: groundingCase.severity,
    gold: groundingCase.gold,
    rawResponse: probe.rawText,
    matches,
    durationMs: probe.durationMs,
    ...llmRoute(opts.llm),
    ...(probe.decision !== undefined ? { actual: probe.decision } : {}),
    ...(groundingCase.pairId !== undefined ? { pairId: groundingCase.pairId } : {}),
    ...(groundingCase.pairRole !== undefined ? { pairRole: groundingCase.pairRole } : {}),
    ...(probe.error !== undefined ? { parseError: probe.error } : {}),
    ...(probe.errorKind !== undefined ? { errorKind: probe.errorKind } : {}),
    ...(probe.tokens !== undefined ? { tokens: probe.tokens } : {}),
    ...(typeof probe.costUsd === "number" ? { costUsd: probe.costUsd } : {}),
  }
  return { verdict, payload }
}

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> => {
  const width = Math.max(1, Math.floor(concurrency))
  const out = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => worker()))
  return out
}

export const runGroundingPreflightCheck = async (
  llm: LLMPort,
  now?: () => number,
): Promise<GroundingPreflightResult> =>
  runGroundingPreflight({
    llm,
    ...(now !== undefined ? { now } : {}),
  })

export const runGrounding = async (opts: GroundingRunOpts): Promise<GroundingRunSummary> => {
  const start = Date.now()
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("grounding", opts.now)
  const loaded = loadGroundingCases(opts)
  const filtered = loaded.filter((groundingCase) =>
    opts.caseId === undefined ? true : groundingCase.id === opts.caseId,
  )
  const selected =
    opts.limit !== undefined && opts.limit >= 0 ? filtered.slice(0, opts.limit) : filtered
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1))
  const executed = await mapWithConcurrency(selected, concurrency, (groundingCase) =>
    executeGroundingCase(groundingCase, opts),
  )
  const counts = emptyCounts()
  for (const [index, execution] of executed.entries()) {
    counts[execution.verdict] += 1
    await store.append(runId, {
      tier: "grounding",
      usecase: selected[index]?.usecase ?? "persistent-context.conversation-state.thread-grounding",
      payload: execution.payload,
    })
  }
  const durationMs = Date.now() - start
  const route = llmRoute(opts.llm)
  await store.finish({
    runId,
    tier: "grounding",
    argv: process.argv.slice(2),
    counts,
    durationMs,
    status: "finished",
    params: {
      suite: opts.suite,
      model: opts.llm.model ?? "unknown",
      provider: opts.llm.provider ?? "unknown",
      concurrency,
      ...(opts.llm.surfaceId !== undefined ? { surfaceId: opts.llm.surfaceId } : {}),
      ...(opts.llm.transportId !== undefined ? { transportId: opts.llm.transportId } : {}),
      ...(opts.llm.authMode !== undefined ? { authMode: opts.llm.authMode } : {}),
      ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    },
  })
  return {
    runId,
    suite: opts.suite,
    total: selected.length,
    counts,
    durationMs,
    concurrency,
    ...route,
  }
}

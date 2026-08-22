import type { LLMPort } from "@/llm"
import { type GroundingPayload, makeRunId, ResultStore } from "../storage"
import type { Verdict } from "../types"
import {
  type GroundingExecutionConfig,
  manualSuiteForCorpus,
  resolveGroundingCorpus,
  resolveGroundingExecutionConfig,
} from "./config"
import {
  buildGroundingExecutionContract,
  type GroundingExecutionRoute,
  groundingExecutionContractFingerprint,
} from "./execution-contract"
import { groundingHarnessFingerprint } from "./harness"
import { type LoadGroundingCasesOpts, loadGroundingCases } from "./loader"
import { normalizeGroundingDecision } from "./normalizer"
import { type GroundingPreflightResult, runGroundingPreflight, runGroundingProbe } from "./probe"
import type { GroundingCase, GroundingCorpus, GroundingMode, GroundingSuite } from "./schema"
import { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"
import { shortHash, stableJson } from "./stable-json"

export {
  type GroundingBaselineResolution,
  type GroundingBaselineStatus,
  resolveGroundingBaseline,
} from "./baseline"
export {
  buildGroundingComparison,
  buildGroundingRegressionResult,
  evaluateGroundingRegression,
  GROUNDING_REGRESSION_PROFILES,
  type GroundingComparisonOutput,
  type GroundingRegressionFailure,
  type GroundingRegressionOutput,
  type GroundingRegressionProfile,
  type GroundingRegressionResult,
  isGroundingRegressionProfile,
} from "./compare"
export {
  type GroundingExecutionConfig,
  manualSuiteForCorpus,
  resolveGroundingCorpus,
  resolveGroundingExecutionConfig,
} from "./config"
export {
  classifyGroundingInfraError,
  classifyGroundingParserError,
  GROUNDING_ERROR_KINDS,
  type GroundingErrorKind,
} from "./diagnostics"
export {
  buildGroundingExecutionContract,
  type GroundingExecutionContract,
  type GroundingExecutionRoute,
  groundingExecutionContractFingerprint,
} from "./execution-contract"
export {
  extractGroundingFileIds,
  type GroundingSpecificFileContext,
  isGroundingFileId,
  resolveGroundingSpecificFileContext,
} from "./file-context"
export { buildGroundingHarnessManifest, groundingHarnessFingerprint } from "./harness"
export { loadGroundingCases } from "./loader"
export { normalizeGroundingDecision } from "./normalizer"
export { extractJsonObject, parseGroundingDecisionText } from "./parser"
export {
  type GroundingPreflightResult,
  resolveGroundingProbeProfile,
  runGroundingPreflight,
  runGroundingProbe,
} from "./probe"
export {
  type GroundingReferentContext,
  resolveGroundingReferentContext,
} from "./referent-context"
export {
  type BuildGroundingReplayDraftOpts,
  buildGroundingReplayDraft,
  type GroundingReplayDraft,
  type GroundingReplayDraftResult,
  type GroundingReplayPromotionResult,
  type PromoteGroundingReplayDraftOpts,
  promoteGroundingReplayDraft,
  readGroundingReplayDraft,
  type WriteGroundingReplayDraftOpts,
  type WritePromotedGroundingReplayCaseOpts,
  writeGroundingReplayDraft,
  writePromotedGroundingReplayCase,
} from "./replay-scaffold"
export {
  buildGroundingBucketReports,
  buildGroundingGateResult,
  buildGroundingMetrics,
  buildGroundingReport,
  buildGroundingRouteMatrixGateResult,
  evaluateGroundingGate,
  GROUNDING_GATE_PROFILES,
  type GroundingGateFailure,
  type GroundingGateOutput,
  type GroundingGateProfile,
  type GroundingGateResult,
  type GroundingReportOutput,
  type GroundingRouteMatrixFailure,
  type GroundingRouteMatrixGateOutput,
  type GroundingRouteMatrixGateResult,
  isGroundingGateProfile,
} from "./report"
export {
  GROUNDING_ROUTE_MATRICES,
  type GroundingRouteMatrix,
  type GroundingRouteMatrixCell,
  type GroundingRouteMatrixName,
  isGroundingRouteMatrixName,
} from "./route-matrix"
export {
  GROUNDING_BUCKETS,
  GROUNDING_CONFIDENCE,
  GROUNDING_CORPORA,
  GROUNDING_HARNESS_CONTRACT,
  GROUNDING_HISTORY_KINDS,
  GROUNDING_HISTORY_METADATA_FIELDS,
  GROUNDING_INTENTS,
  GROUNDING_MODES,
  GROUNDING_NORMALIZATION_PROFILES,
  GROUNDING_OUTPUT_PROTOCOLS,
  GROUNDING_PAIR_ROLES,
  GROUNDING_PROBE_PROFILES,
  GROUNDING_SCHEMA_VERSION,
  GROUNDING_SCOPES,
  GROUNDING_SEVERITIES,
  GROUNDING_STATE_CONTRACT_FIELDS,
  GROUNDING_SUITES,
  GROUNDING_USECASE,
  type GroundingAmbiguityClass,
  type GroundingBucket,
  type GroundingCase,
  type GroundingConfidence,
  type GroundingContextChange,
  type GroundingCorpus,
  type GroundingDecision,
  type GroundingHistoryEntry,
  type GroundingHistoryKind,
  type GroundingHumanAudit,
  type GroundingIntent,
  type GroundingMode,
  type GroundingNormalizationProfile,
  type GroundingOutputProtocol,
  type GroundingPairRole,
  type GroundingProbeProfile,
  type GroundingSeverity,
  type GroundingSourceProvenance,
  type GroundingStateContract,
  type GroundingSuite,
  parseGroundingCase,
} from "./schema"
export { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"

export interface GroundingRunOpts extends LoadGroundingCasesOpts {
  llm: LLMPort
  mode?: GroundingMode
  caseId?: string
  limit?: number
  concurrency?: number
  storeDir?: string
  now?: () => number
}

export interface GroundingRunSummary extends GroundingExecutionRoute {
  runId: string
  suite?: GroundingSuite
  corpus: GroundingCorpus
  mode: GroundingMode
  probeProfile: GroundingExecutionConfig["probeProfile"]
  normalizationProfile: GroundingExecutionConfig["normalizationProfile"]
  outputProtocol: GroundingExecutionConfig["outputProtocol"]
  total: number
  counts: Record<Verdict, number>
  durationMs: number
  concurrency: number
  caseSetFingerprint: string
  routeFingerprint: string
  executionContractFingerprint: string
  harnessFingerprint: string
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

const llmRoute = (llm: LLMPort): GroundingExecutionRoute => ({
  ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
  ...(llm.model !== undefined ? { model: llm.model } : {}),
  ...(llm.surfaceId !== undefined ? { surfaceId: llm.surfaceId } : {}),
  ...(llm.transportId !== undefined ? { transportId: llm.transportId } : {}),
  ...(llm.authMode !== undefined ? { authMode: llm.authMode } : {}),
})

const caseSetFingerprint = (cases: readonly GroundingCase[]): string => shortHash(stableJson(cases))

const routeFingerprint = (route: GroundingExecutionRoute): string => shortHash(stableJson(route))

const executeGroundingCase = async (
  groundingCase: GroundingCase,
  opts: GroundingRunOpts,
  execConfig: GroundingExecutionConfig,
): Promise<GroundingCaseExecution> => {
  const probe = await runGroundingProbe(groundingCase, {
    llm: opts.llm,
    probeProfile: execConfig.probeProfile,
    outputProtocol: execConfig.outputProtocol,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  let verdict: Verdict = "error"
  const matches = emptyGroundingMatches()
  const normalization =
    probe.error === undefined && probe.decision !== undefined
      ? normalizeGroundingDecision(groundingCase, probe.decision, execConfig.normalizationProfile)
      : undefined
  const rawActual = probe.error === undefined ? probe.decision : undefined
  const normalizedActual =
    execConfig.normalizationProfile === "none" ? undefined : normalization?.decision
  const scoredActual = execConfig.normalizationProfile === "none" ? rawActual : normalizedActual
  const route = llmRoute(opts.llm)
  const executionContractFingerprint = groundingExecutionContractFingerprint(
    buildGroundingExecutionContract(route, execConfig, groundingCase.corpus ?? "canary"),
  )
  if (probe.error === undefined && scoredActual !== undefined) {
    const scored = scoreGroundingDecision(groundingCase, scoredActual)
    verdict = scored.verdict
    Object.assign(matches, scored.matches)
  }
  const payload: GroundingPayload = {
    kind: "grounding",
    suite: manualSuiteForCorpus(groundingCase.corpus ?? "canary") ?? "canary",
    corpus: groundingCase.corpus ?? "canary",
    mode: execConfig.mode,
    probeProfile: execConfig.probeProfile,
    normalizationProfile: execConfig.normalizationProfile,
    structuredOutputProtocol: execConfig.outputProtocol,
    structuredOutputValid: probe.structuredOutputValid,
    caseId: groundingCase.id,
    verdict,
    bucket: groundingCase.bucket,
    severity: groundingCase.severity,
    gold: groundingCase.gold,
    rawResponse: probe.rawText,
    matches,
    durationMs: probe.durationMs,
    ...llmRoute(opts.llm),
    ...(rawActual !== undefined ? { rawActual } : {}),
    ...(normalizedActual !== undefined ? { normalizedActual } : {}),
    ...(scoredActual !== undefined ? { scoredActual, actual: scoredActual } : {}),
    normalizationApplied: normalization?.applied ?? false,
    ...(normalization !== undefined ? { normalizationReasons: [...normalization.reasons] } : {}),
    executionContractFingerprint,
    ...(groundingCase.sourceProvenance !== undefined
      ? { sourceProvenance: groundingCase.sourceProvenance }
      : {}),
    ...(groundingCase.humanAudit !== undefined ? { humanAudit: groundingCase.humanAudit } : {}),
    ...(groundingCase.candidateThreadIds !== undefined
      ? { candidateThreadIds: groundingCase.candidateThreadIds }
      : {}),
    ...(groundingCase.candidateReferentIds !== undefined
      ? { candidateReferentIds: groundingCase.candidateReferentIds }
      : {}),
    ...(groundingCase.ambiguityClass !== undefined
      ? { ambiguityClass: groundingCase.ambiguityClass }
      : {}),
    ...(groundingCase.blockingEligible !== undefined
      ? { blockingEligible: groundingCase.blockingEligible }
      : {}),
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
  const corpus = resolveGroundingCorpus(opts.corpus, opts.suite)
  const mode = opts.mode ?? "engine"
  const execConfig = resolveGroundingExecutionConfig(mode)
  const store = new ResultStore({
    ...(opts.storeDir !== undefined ? { dir: opts.storeDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const runId = makeRunId("grounding", opts.now)
  const loaded = loadGroundingCases({ ...opts, corpus })
  const filtered = loaded.filter((groundingCase) =>
    opts.caseId === undefined ? true : groundingCase.id === opts.caseId,
  )
  const selected =
    opts.limit !== undefined && opts.limit >= 0 ? filtered.slice(0, opts.limit) : filtered
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1))
  const caseFingerprint = caseSetFingerprint(selected)
  const executed = await mapWithConcurrency(selected, concurrency, (groundingCase) =>
    executeGroundingCase(groundingCase, opts, execConfig),
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
  const routeFp = routeFingerprint(route)
  const executionContractFp = groundingExecutionContractFingerprint(
    buildGroundingExecutionContract(route, execConfig, corpus),
  )
  const harnessFp = groundingHarnessFingerprint()
  const suite = manualSuiteForCorpus(corpus)
  await store.finish({
    runId,
    tier: "grounding",
    argv: process.argv.slice(2),
    counts,
    durationMs,
    status: "finished",
    params: {
      suite: suite ?? corpus,
      corpus,
      mode,
      probeProfile: execConfig.probeProfile,
      normalizationProfile: execConfig.normalizationProfile,
      outputProtocol: execConfig.outputProtocol,
      model: opts.llm.model ?? "unknown",
      provider: opts.llm.provider ?? "unknown",
      concurrency,
      caseCount: selected.length,
      caseSetFingerprint: caseFingerprint,
      routeFingerprint: routeFp,
      executionContractFingerprint: executionContractFp,
      harnessFingerprint: harnessFp,
      ...(opts.llm.surfaceId !== undefined ? { surfaceId: opts.llm.surfaceId } : {}),
      ...(opts.llm.transportId !== undefined ? { transportId: opts.llm.transportId } : {}),
      ...(opts.llm.authMode !== undefined ? { authMode: opts.llm.authMode } : {}),
      ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    },
  })
  return {
    runId,
    ...(suite !== undefined ? { suite } : {}),
    corpus,
    mode,
    probeProfile: execConfig.probeProfile,
    normalizationProfile: execConfig.normalizationProfile,
    outputProtocol: execConfig.outputProtocol,
    total: selected.length,
    counts,
    durationMs,
    concurrency,
    caseSetFingerprint: caseFingerprint,
    routeFingerprint: routeFp,
    executionContractFingerprint: executionContractFp,
    harnessFingerprint: harnessFp,
    ...route,
  }
}

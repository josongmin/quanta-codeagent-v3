import type { LLMPort } from "@/llm"
import { makeRunId, ResultStore, type GroundingPayload } from "../storage"
import type { Verdict } from "../types"
import {
  manualSuiteForCorpus,
  resolveGroundingCorpus,
  resolveGroundingExecutionConfig,
  type GroundingExecutionConfig,
} from "./config"
import { groundingHarnessFingerprint } from "./harness"
import { loadGroundingCases, type LoadGroundingCasesOpts } from "./loader"
import {
  runGroundingPreflight,
  runGroundingProbe,
  type GroundingPreflightResult,
} from "./probe"
import { normalizeGroundingDecision } from "./normalizer"
import { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"
import type { GroundingCase, GroundingCorpus, GroundingMode, GroundingSuite } from "./schema"
import { shortHash, stableJson } from "./stable-json"

export {
  manualSuiteForCorpus,
  resolveGroundingCorpus,
  resolveGroundingExecutionConfig,
  type GroundingExecutionConfig,
} from "./config"
export {
  resolveGroundingBaseline,
  type GroundingBaselineResolution,
  type GroundingBaselineStatus,
} from "./baseline"
export {
  buildGroundingComparison,
  buildGroundingRegressionResult,
  evaluateGroundingRegression,
  GROUNDING_REGRESSION_PROFILES,
  isGroundingRegressionProfile,
  type GroundingComparisonOutput,
  type GroundingRegressionFailure,
  type GroundingRegressionOutput,
  type GroundingRegressionProfile,
  type GroundingRegressionResult,
} from "./compare"
export {
  buildGroundingGateResult,
  buildGroundingRouteMatrixGateResult,
  buildGroundingReport,
  buildGroundingBucketReports,
  buildGroundingMetrics,
  evaluateGroundingGate,
  GROUNDING_GATE_PROFILES,
  isGroundingGateProfile,
  type GroundingGateFailure,
  type GroundingGateOutput,
  type GroundingGateProfile,
  type GroundingGateResult,
  type GroundingRouteMatrixFailure,
  type GroundingRouteMatrixGateOutput,
  type GroundingRouteMatrixGateResult,
  type GroundingReportOutput,
} from "./report"
export {
  GROUNDING_BUCKETS,
  GROUNDING_CORPORA,
  GROUNDING_CONFIDENCE,
  GROUNDING_HARNESS_CONTRACT,
  GROUNDING_HISTORY_METADATA_FIELDS,
  GROUNDING_HISTORY_KINDS,
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
  parseGroundingCase,
  type GroundingAmbiguityClass,
  type GroundingBucket,
  type GroundingCase,
  type GroundingConfidence,
  type GroundingCorpus,
  type GroundingContextChange,
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
  extractGroundingFileIds,
  isGroundingFileId,
  resolveGroundingSpecificFileContext,
  type GroundingSpecificFileContext,
} from "./file-context"
export {
  resolveGroundingReferentContext,
  type GroundingReferentContext,
} from "./referent-context"
export {
  runGroundingPreflight,
  runGroundingProbe,
  resolveGroundingProbeProfile,
  type GroundingPreflightResult,
} from "./probe"
export { normalizeGroundingDecision } from "./normalizer"
export { buildGroundingHarnessManifest, groundingHarnessFingerprint } from "./harness"
export {
  GROUNDING_ROUTE_MATRICES,
  isGroundingRouteMatrixName,
  type GroundingRouteMatrix,
  type GroundingRouteMatrixCell,
  type GroundingRouteMatrixName,
} from "./route-matrix"
export {
  buildGroundingReplayScaffold,
  writeGroundingReplayScaffold,
  type BuildGroundingReplayScaffoldOpts,
  type GroundingReplayScaffoldResult,
  type WriteGroundingReplayScaffoldOpts,
} from "./replay-scaffold"

export interface GroundingRunOpts extends LoadGroundingCasesOpts {
  llm: LLMPort
  mode?: GroundingMode
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

const llmRoute = (llm: LLMPort): GroundingRunRoute => ({
  ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
  ...(llm.model !== undefined ? { model: llm.model } : {}),
  ...(llm.surfaceId !== undefined ? { surfaceId: llm.surfaceId } : {}),
  ...(llm.transportId !== undefined ? { transportId: llm.transportId } : {}),
  ...(llm.authMode !== undefined ? { authMode: llm.authMode } : {}),
})

const caseSetFingerprint = (cases: readonly GroundingCase[]): string => shortHash(stableJson(cases))

const routeFingerprint = (route: GroundingRunRoute): string => shortHash(stableJson(route))

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
      ? normalizeGroundingDecision(
          groundingCase,
          probe.decision,
          execConfig.normalizationProfile,
        )
      : undefined
  const rawActual = probe.error === undefined ? probe.decision : undefined
  const normalizedActual =
    execConfig.normalizationProfile === "none" ? undefined : normalization?.decision
  const scoredActual =
    execConfig.normalizationProfile === "none" ? rawActual : normalizedActual
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
    ...(groundingCase.sourceProvenance !== undefined ? { sourceProvenance: groundingCase.sourceProvenance } : {}),
    ...(groundingCase.humanAudit !== undefined ? { humanAudit: groundingCase.humanAudit } : {}),
    ...(groundingCase.candidateThreadIds !== undefined ? { candidateThreadIds: groundingCase.candidateThreadIds } : {}),
    ...(groundingCase.candidateReferentIds !== undefined ? { candidateReferentIds: groundingCase.candidateReferentIds } : {}),
    ...(groundingCase.ambiguityClass !== undefined ? { ambiguityClass: groundingCase.ambiguityClass } : {}),
    ...(groundingCase.blockingEligible !== undefined ? { blockingEligible: groundingCase.blockingEligible } : {}),
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
    harnessFingerprint: harnessFp,
    ...route,
  }
}

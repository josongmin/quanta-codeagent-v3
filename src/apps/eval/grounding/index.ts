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
import { type GroundingNormalizationResult, normalizeGroundingDecision } from "./normalizer"
import {
  type GroundingPreflightResult,
  type GroundingProbeResult,
  runGroundingPreflight,
  runGroundingProbe,
} from "./probe"
import type {
  GroundingCase,
  GroundingCorpus,
  GroundingDecision,
  GroundingMode,
  GroundingSuite,
} from "./schema"
import { emptyGroundingMatches, scoreGroundingDecision } from "./scorer"
import { shortHash, stableJson } from "./stable-json"

export {
  type GroundingBaselineResolution,
  type GroundingBaselineStatus,
  resolveGroundingBaseline,
} from "./baseline"
export { buildGroundingComparison, type GroundingComparisonOutput } from "./compare"
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
export {
  buildGroundingGateResult,
  buildGroundingRouteMatrixGateResult,
  evaluateGroundingGate,
  GROUNDING_GATE_PROFILES,
  type GroundingGateFailure,
  type GroundingGateOutput,
  type GroundingGateProfile,
  type GroundingGateResult,
  type GroundingRouteMatrixFailure,
  type GroundingRouteMatrixGateOutput,
  type GroundingRouteMatrixGateResult,
  isGroundingGateProfile,
} from "./gate"
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
  buildGroundingRegressionResult,
  evaluateGroundingRegression,
  GROUNDING_REGRESSION_PROFILES,
  type GroundingRegressionFailure,
  type GroundingRegressionOutput,
  type GroundingRegressionProfile,
  type GroundingRegressionResult,
  isGroundingRegressionProfile,
} from "./regression"
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
  buildGroundingMetrics,
  buildGroundingReport,
  type GroundingReportOutput,
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

/** The scored view of one probe response: what the model said (`rawActual`),
 *  what normalization made of it (`normalizedActual`), and which of the two the
 *  scorer actually saw (`scoredActual`). */
interface GroundingCaseOutcome {
  readonly verdict: Verdict
  readonly matches: ReturnType<typeof emptyGroundingMatches>
  readonly normalization: GroundingNormalizationResult | undefined
  readonly rawActual: GroundingDecision | undefined
  readonly normalizedActual: GroundingDecision | undefined
  readonly scoredActual: GroundingDecision | undefined
}

/**
 * Score one probe response against its case.
 *
 * A unit because the three decision views above are derived from the SAME
 * response under one profile: keeping the selection and the scoring together is
 * what guarantees the payload's `scoredActual` is the value that produced
 * `verdict`, rather than a second, independently-recomputed guess.
 */
const resolveGroundingOutcome = (
  groundingCase: GroundingCase,
  probe: GroundingProbeResult,
  normalizationProfile: GroundingExecutionConfig["normalizationProfile"],
): GroundingCaseOutcome => {
  const normalization =
    probe.error === undefined && probe.decision !== undefined
      ? normalizeGroundingDecision(groundingCase, probe.decision, normalizationProfile)
      : undefined
  const rawActual = probe.error === undefined ? probe.decision : undefined
  const normalizedActual = normalizationProfile === "none" ? undefined : normalization?.decision
  const scoredActual = normalizationProfile === "none" ? rawActual : normalizedActual
  const matches = emptyGroundingMatches()
  let verdict: Verdict = "error"
  if (probe.error === undefined && scoredActual !== undefined) {
    const scored = scoreGroundingDecision(groundingCase, scoredActual)
    verdict = scored.verdict
    Object.assign(matches, scored.matches)
  }
  return { verdict, matches, normalization, rawActual, normalizedActual, scoredActual }
}

/**
 * The case-authoring metadata copied verbatim onto the payload.
 *
 * A unit because every field here is pure pass-through provenance the runner
 * never derives, and each must be OMITTED rather than set to `undefined` when
 * the case omits it — one shared rule, stated once.
 */
const caseProvenanceFields = (
  groundingCase: GroundingCase,
): Partial<
  Pick<
    GroundingPayload,
    | "sourceProvenance"
    | "humanAudit"
    | "candidateThreadIds"
    | "candidateReferentIds"
    | "ambiguityClass"
    | "blockingEligible"
    | "pairId"
    | "pairRole"
  >
> => ({
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
})

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
  const { verdict, matches, normalization, rawActual, normalizedActual, scoredActual } =
    resolveGroundingOutcome(groundingCase, probe, execConfig.normalizationProfile)
  const route = llmRoute(opts.llm)
  const executionContractFingerprint = groundingExecutionContractFingerprint(
    buildGroundingExecutionContract(route, execConfig, groundingCase.corpus ?? "canary"),
  )
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
    ...caseProvenanceFields(groundingCase),
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

/**
 * The exact case set this run will execute: load the corpus, then apply the
 * caller's `caseId` pin and `limit` budget in that order.
 *
 * A unit because the selection is what `caseSetFingerprint` hashes — pin and
 * limit must be applied in one place, in this order, or a re-run with the same
 * options can fingerprint a different set than it executes.
 */
const selectGroundingCases = (
  opts: GroundingRunOpts,
  corpus: GroundingCorpus,
): readonly GroundingCase[] => {
  const loaded = loadGroundingCases({ ...opts, corpus })
  const filtered = loaded.filter((groundingCase) =>
    opts.caseId === undefined ? true : groundingCase.id === opts.caseId,
  )
  return opts.limit !== undefined && opts.limit >= 0 ? filtered.slice(0, opts.limit) : filtered
}

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
  const selected = selectGroundingCases(opts, corpus)
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

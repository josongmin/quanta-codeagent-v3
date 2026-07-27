import { readFileSync } from "node:fs"
import { join } from "node:path"
import { extractIssueHint } from "@/agent/issue-hint"
import { extractIssueDeclaredExpected } from "@/agent/verification-plan"
import { isCaptureFailure } from "@/runner/batch/eval/capture-correctness"
import { buildPublicDeclaredExpectedPort } from "@/runner/batch/eval/declared-expected-matcher"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  computeEffectiveProofRequired,
  deriveCandidateStructuralRepair,
  familyCoverageCoeditEnabled,
  makeCalibratedReproConsensusPort,
  makeReproConsensusProofSelectionPort,
  makeReproConsensusSelectionPort,
  makeSelectionRegressionPort,
  makeSelectionStaticSanityPort,
  type PreparedAttemptContext,
  resolveBenchKnobs,
  resolveLaneLlm,
  validatedReproRepairSeed,
} from "@/runner/batch/eval/driver"
import { coeditFamilyCoverageCandidate } from "@/runner/batch/eval/family-coverage-coedit"
import {
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  recordLlmEvidencePacket,
  type SelectionGenerationPromptInput,
  type VerificationTargetFact,
  verificationTargetFromPlan,
} from "@/runner/batch/eval/llm-evidence-packet"
import { prepareMweProofSelectionPort } from "@/runner/batch/eval/mwe-proof-port"
import type { SelectionContractBundle } from "@/runner/batch/eval/public-contract-types"
import { candidatePatchAppliesCleanly } from "@/runner/batch/eval/rematerialize"
import {
  makeDiscoveredRepoRegressionPort,
  makeDiscoveredRepoRegressionProofPort,
} from "@/runner/batch/eval/repo-regression-discovery-adapter"
import { unavailableReproOracleCalibration } from "@/runner/batch/eval/repro-oracle-calibration"
import {
  composeSelectionAgentHint,
  prepareSelectionEvidenceContext,
} from "@/runner/batch/eval/selection-assembly"
import {
  type Candidate,
  filesFromPatch,
  runSelection,
  type SelectionInputs,
  type SelectionPorts,
  type SelectionResult,
  type SelectionTelemetry,
  summarizeSelection,
} from "@/runner/batch/eval/selection-executor"
import { selectionGenerationErrorOf } from "@/runner/batch/eval/selection-generation-error"
import { buildSelectionRiskGate } from "@/runner/batch/eval/selection-risk-gate"
import { prepareIssueSmokeSelectionPort } from "@/runner/batch/eval/selection-smoke"
import { gateOn } from "@/shared"
import type { BenchReproTestTelemetry, Instance, ReproOracleCalibration } from "../../types"
import type { Wiring } from "../report"
import { cleanupSandbox, forkSandbox } from "../sandbox"
import { captureLostEditsError, type Phase, runAgentPhase } from "./agent-phase"
import type { RunInstanceDeps } from "./deps"

export interface SelectionReproPolicy {
  readonly enabled: boolean
  readonly goldCalibrate: boolean
  readonly resolvedKofNMode: "hard" | "soft"
}

/** Live-like no-oracle rule for verify-select repro use:
 *  - `positive` keeps the generated repro signal as SOFT-ONLY and MUST NOT peek
 *    at gold calibration.
 *  - unset / `hard` preserves the legacy eval-only gold-calibrated hard gate.
 *  - `off` removes the selection signal entirely. */
export const selectionReproPolicy = (
  mode: BenchPosture["verifySelectRepro"],
): SelectionReproPolicy => {
  if (mode === "off") {
    return { enabled: false, goldCalibrate: false, resolvedKofNMode: "hard" }
  }
  if (mode === "positive") {
    return { enabled: true, goldCalibrate: false, resolvedKofNMode: "soft" }
  }
  return { enabled: true, goldCalibrate: true, resolvedKofNMode: "hard" }
}

const resolveSelectionReproConsensus = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
  reproSources: readonly string[],
  mode: BenchPosture["verifySelectRepro"],
  proofRequired: boolean,
) => {
  const reproPolicy = selectionReproPolicy(mode)
  const calibrationUnavailable = unavailableReproOracleCalibration()
  if (!reproPolicy.enabled) {
    return {
      reproPolicy,
      resolvedKofNSelectionPort: undefined,
      reproConsensusProofSelectionPort: undefined,
      calibration: calibrationUnavailable,
      proofCalibration: calibrationUnavailable,
    }
  }
  if (reproPolicy.goldCalibrate) {
    const { port, calibration } = await makeCalibratedReproConsensusPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    )
    return {
      reproPolicy,
      resolvedKofNSelectionPort: port,
      reproConsensusProofSelectionPort: makeReproConsensusProofSelectionPort(
        instance,
        reproSources,
        sandbox,
        timeoutMs,
      ),
      calibration,
      proofCalibration: proofRequired ? calibration : calibrationUnavailable,
    }
  }
  // `positive` keeps the resolvedKofN port uncalibrated, but a proof-required
  // gate still needs gold-derived oracle truth so a broken canonical repro rail
  // cannot withhold the correct fix.
  const proofCalibration = proofRequired
    ? (await makeCalibratedReproConsensusPort(instance, reproSources, sandbox, timeoutMs))
        .calibration
    : calibrationUnavailable
  return {
    reproPolicy,
    resolvedKofNSelectionPort: makeReproConsensusSelectionPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    ),
    reproConsensusProofSelectionPort: makeReproConsensusProofSelectionPort(
      instance,
      reproSources,
      sandbox,
      timeoutMs,
    ),
    calibration: calibrationUnavailable,
    proofCalibration,
  }
}

const generateSelectionCandidate = async (args: {
  readonly index: number
  readonly seed: string | undefined
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly mergeHint: (seed: string | undefined) => string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly concurrency: number | undefined
  readonly baseValidatedRed: boolean | null
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
}): Promise<Candidate> => {
  const isolated = args.concurrency !== undefined && args.concurrency > 1
  const candidateSandbox = isolated
    ? await forkSandbox(args.instance.id, args.sandbox)
    : args.sandbox
  // G1 cross-vendor diversity: resolve the per-candidate generator lane from the
  // SAME posture buildConfig reads, so candidate `index` is served by vendor lane
  // (index mod V) when the model-lane-diversity knob is on AND ≥2 lanes were
  // injected. Resolves to deps.llm otherwise (byte-identical single-vendor path).
  const lanePosture =
    args.postureOverride ??
    benchPostureFromState(
      args.stateOverride ?? resolveBenchKnobs({ envVars: process.env }),
      process.env,
    )
  const laneLlm = resolveLaneLlm(args.deps, lanePosture.modelLaneDiversity, args.index)
  try {
    const phase = await runAgentPhase(
      args.instance,
      args.deps,
      candidateSandbox,
      args.signal,
      args.wiring,
      args.precomputedHint,
      args.reproHint,
      args.mergeHint(args.seed),
      args.postureOverride,
      args.stateOverride,
      laneLlm,
    )
    args.addTurns(phase.turns)
    // T5 — a fork-worktree capture desync (edits made, 0-byte diff on a CLEAN
    // tree) is an INFRA failure, not a model miss. This is the concurrency>1 fork
    // path where 11138's empty 0-byte submission occurred. Label it distinctly
    // BEFORE the generic empty-patch path so it is not laundered into the
    // no-fix/model-miss bucket (the measurement-hole confound this project fences).
    if (phase.captureClass !== undefined && isCaptureFailure(phase.captureClass)) {
      const captureError = captureLostEditsError(phase.editCount, candidateSandbox)
      args.generationErrors.set(args.index, captureError)
      throw new Error(captureError)
    }
    const generationError = selectionGenerationErrorOf({
      stopReason: phase.stopReason,
      patch: phase.patch,
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
    })
    if (generationError !== undefined) {
      args.generationErrors.set(args.index, generationError)
      throw new Error(generationError)
    }
    return {
      id: `cand-${args.index}`,
      patch: phase.patch,
      turns: phase.turns,
      files: filesFromPatch(phase.patch),
      baseValidatedRed: args.baseValidatedRed,
      sandboxPath: candidateSandbox,
      ...(phase.captureClass !== undefined ? { captureClass: phase.captureClass } : {}),
      ...(phase.stopReason !== undefined ? { stopReason: phase.stopReason } : {}),
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
      ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
      ...(phase.sourceAppliedEditCount !== undefined
        ? { sourceAppliedEditCount: phase.sourceAppliedEditCount }
        : {}),
    }
  } finally {
    if (isolated) await cleanupSandbox(candidateSandbox)
  }
}

const readSandboxSource = (sandbox: string, rel: string): string | null => {
  try {
    return readFileSync(join(sandbox, rel), "utf8")
  } catch {
    return null
  }
}

const optionalLlmEvidence = (
  llmEvidence: Partial<LlmEvidenceArtifacts>,
): { readonly llmEvidence?: LlmEvidenceArtifacts } =>
  Object.keys(llmEvidence).length > 0 ? { llmEvidence: llmEvidence as LlmEvidenceArtifacts } : {}

const generationFailureSamplesOf = (
  generationErrors: ReadonlyMap<number, string>,
): readonly string[] =>
  [...generationErrors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, error]) => error)
    .slice(0, 2)

const selectionTelemetryWithGenerationFailures = (args: {
  readonly result: SelectionResult
  readonly generationErrors: ReadonlyMap<number, string>
}): SelectionTelemetry => {
  const telemetry = summarizeSelection(args.result)
  const samples = generationFailureSamplesOf(args.generationErrors)
  return samples.length === 0 ? telemetry : { ...telemetry, generationFailureSamples: samples }
}

const selectionGenerationFailedPhase = (args: {
  readonly result: SelectionResult
  readonly generationErrors: ReadonlyMap<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly calibration: Phase["reproOracleCalibration"]
  readonly llmEvidence: Partial<LlmEvidenceArtifacts>
}): Phase => {
  const samples = generationFailureSamplesOf(args.generationErrors)
  const sample = samples.join("; ")
  return {
    patch: "",
    turns: args.totalTurns,
    stopReason: "error",
    agentError:
      "agent stopped with error before verification: " +
      `verify-select candidate generation failed for all ${args.n} candidates` +
      (sample === "" ? "" : ` (${sample})`),
    ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
    selectionTelemetry: selectionTelemetryWithGenerationFailures(args),
    ...optionalLlmEvidence(args.llmEvidence),
  }
}

const selectionWinnerPhase = (args: {
  readonly result: SelectionResult
  readonly generationErrors: ReadonlyMap<number, string>
  readonly totalTurns: number
  readonly calibration: Phase["reproOracleCalibration"]
  readonly llmEvidence: Partial<LlmEvidenceArtifacts>
}): Phase => ({
  patch: args.result.winner?.patch ?? args.result.fallbackCandidate?.patch ?? "",
  turns: args.totalTurns,
  ...(args.result.terminalCandidate?.stopReason !== undefined
    ? { stopReason: args.result.terminalCandidate.stopReason }
    : {}),
  ...(args.result.terminalCandidate?.agentError !== undefined
    ? { agentError: args.result.terminalCandidate.agentError }
    : {}),
  ...(args.result.terminalCandidate?.editCount !== undefined
    ? { editCount: args.result.terminalCandidate.editCount }
    : {}),
  ...(args.result.terminalCandidate?.sourceAppliedEditCount !== undefined
    ? { sourceAppliedEditCount: args.result.terminalCandidate.sourceAppliedEditCount }
    : {}),
  ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
  selectionTelemetry: selectionTelemetryWithGenerationFailures(args),
  ...optionalLlmEvidence(args.llmEvidence),
})

const selectionPhaseFromResult = (args: {
  readonly result: SelectionResult
  readonly generationErrors: ReadonlyMap<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly calibration: Phase["reproOracleCalibration"]
  readonly llmEvidence: Partial<LlmEvidenceArtifacts>
}): Phase =>
  args.result.successfulGenerations === 0 && args.result.generationFailures > 0
    ? selectionGenerationFailedPhase(args)
    : selectionWinnerPhase(args)

interface SelectionPortsArgs {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly mergeHint: (seed: string | undefined) => string | undefined
  readonly concurrency: number | undefined
  readonly baseValidatedRed: boolean | null
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
  readonly chaRepairTargets: PreparedAttemptContext["chaRepairTargets"]
  readonly staticSanitySelectionPort: NonNullable<SelectionPorts["staticSanity"]>
  readonly regressionSelectionPort: NonNullable<SelectionPorts["regression"]>
  readonly publicRegressionProofSelectionPort?: SelectionPorts["publicRegressionProof"]
  readonly smokeSelectionPort?: SelectionPorts["smoke"]
  readonly mweProofSelectionPort?: SelectionPorts["mweProof"]
  readonly resolvedKofNSelectionPort?: SelectionPorts["resolvedKofN"]
  readonly reproConsensusProofSelectionPort?: SelectionPorts["reproConsensusProof"]
  readonly selectorMode: BenchPosture["selectorMode"]
}

const selectionGeneratePort =
  (args: SelectionPortsArgs): SelectionPorts["generate"] =>
  (i, seed) =>
    generateSelectionCandidate({
      index: i,
      seed,
      instance: args.instance,
      deps: args.deps,
      sandbox: args.sandbox,
      signal: args.signal,
      wiring: args.wiring,
      precomputedHint: args.precomputedHint,
      reproHint: args.reproHint,
      postureOverride: args.postureOverride,
      stateOverride: args.stateOverride,
      mergeHint: args.mergeHint,
      concurrency: args.concurrency,
      baseValidatedRed: args.baseValidatedRed,
      generationErrors: args.generationErrors,
      addTurns: args.addTurns,
    })

const selectionStructuralRepairPorts = (args: SelectionPortsArgs): Partial<SelectionPorts> =>
  args.selectorMode === "clean"
    ? {
        deriveCandidateStructuralRepair: (candidate: Candidate) =>
          deriveCandidateStructuralRepair({
            instance: args.instance,
            candidate,
            sandbox: args.sandbox,
            signal: args.signal,
            preferredTargets: args.chaRepairTargets,
          }),
        ...(familyCoverageCoeditEnabled(process.env)
          ? {
              repairFamilyCoverage: ({ candidate, family, missingFiles }) =>
                coeditFamilyCoverageCandidate({
                  sandbox: args.sandbox,
                  candidate,
                  family,
                  missingFiles,
                  timeoutMs: args.deps.timeoutMs,
                  baseCommit: args.instance.swebench?.baseCommit,
                  repo: args.instance.swebench?.repo,
                  preferredTargets: args.chaRepairTargets,
                }),
            }
          : {}),
      }
    : {}

const selectionProofPorts = (args: SelectionPortsArgs): Partial<SelectionPorts> => ({
  ...(args.publicRegressionProofSelectionPort !== undefined
    ? { publicRegressionProof: args.publicRegressionProofSelectionPort }
    : {}),
  ...(args.smokeSelectionPort !== undefined ? { smoke: args.smokeSelectionPort } : {}),
  ...(args.mweProofSelectionPort !== undefined ? { mweProof: args.mweProofSelectionPort } : {}),
  ...(args.resolvedKofNSelectionPort !== undefined
    ? { resolvedKofN: args.resolvedKofNSelectionPort }
    : {}),
  ...(args.reproConsensusProofSelectionPort !== undefined
    ? { reproConsensusProof: args.reproConsensusProofSelectionPort }
    : {}),
})

const selectionPorts = (args: SelectionPortsArgs): SelectionPorts => ({
  generate: selectionGeneratePort(args),
  applyClean: (candidate) =>
    candidatePatchAppliesCleanly({
      sandbox: args.sandbox,
      patch: candidate.patch,
      baseCommit: args.instance.swebench?.baseCommit,
      timeoutMs: args.deps.timeoutMs,
    }),
  staticSanity: args.staticSanitySelectionPort,
  regression: args.regressionSelectionPort,
  ...selectionProofPorts(args),
  ...selectionStructuralRepairPorts(args),
})

interface PreparedSelectionRuntimePorts {
  readonly reproPolicy: SelectionReproPolicy
  readonly resolvedKofNSelectionPort: SelectionPorts["resolvedKofN"] | undefined
  readonly reproConsensusProofSelectionPort: SelectionPorts["reproConsensusProof"] | undefined
  readonly publicRegressionProofSelectionPort: SelectionPorts["publicRegressionProof"] | undefined
  readonly regressionSelectionPort: NonNullable<SelectionPorts["regression"]>
  readonly staticSanitySelectionPort: NonNullable<SelectionPorts["staticSanity"]>
  readonly smokeSelectionPort: SelectionPorts["smoke"] | undefined
  readonly mweProofSelectionPort: SelectionPorts["mweProof"] | undefined
  readonly calibration: ReproOracleCalibration
  readonly proofCalibration: ReproOracleCalibration
}

const prepareSelectionRuntimePorts = async (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
  readonly reproSources: readonly string[]
  readonly verifySelectRepro: BenchPosture["verifySelectRepro"]
  readonly verifySelectProofRequired: boolean
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly selectorMode: BenchPosture["selectorMode"]
}): Promise<PreparedSelectionRuntimePorts> => {
  const {
    reproPolicy,
    resolvedKofNSelectionPort,
    reproConsensusProofSelectionPort,
    calibration,
    proofCalibration,
  } = await resolveSelectionReproConsensus(
    args.instance,
    args.sandbox,
    args.timeoutMs,
    args.reproSources,
    args.verifySelectRepro,
    args.verifySelectProofRequired,
  )
  const discoveredRegressionPort =
    args.verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.timeoutMs,
        })
      : undefined
  return {
    reproPolicy,
    resolvedKofNSelectionPort,
    reproConsensusProofSelectionPort,
    publicRegressionProofSelectionPort:
      args.verifySelectRegression === "discovered"
        ? makeDiscoveredRepoRegressionProofPort({
            instance: args.instance,
            sandbox: args.sandbox,
            timeoutMs: args.timeoutMs,
          })
        : undefined,
    regressionSelectionPort: makeSelectionRegressionPort({
      verifySelectRegression: args.verifySelectRegression,
      discoveredRegressionPort,
      instance: args.instance,
      sandbox: args.sandbox,
      timeoutMs: args.timeoutMs,
    }),
    staticSanitySelectionPort: makeSelectionStaticSanityPort({
      sandbox: args.sandbox,
      baseCommit: args.instance.swebench?.baseCommit,
      timeoutMs: args.timeoutMs,
    }),
    smokeSelectionPort: await prepareIssueSmokeSelectionPort(
      args.instance,
      args.sandbox,
      args.timeoutMs,
    ),
    mweProofSelectionPort:
      args.selectorMode === "clean"
        ? await prepareMweProofSelectionPort(args.instance, args.sandbox, args.timeoutMs)
        : undefined,
    calibration,
    proofCalibration,
  }
}

interface SelectionExecutionArgs {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly n: number
  readonly concurrency: number | undefined
  readonly earlyAccept: boolean
  readonly riskGate: boolean
  readonly llmRiskGateMode: BenchPosture["verifySelectLlmRiskGate"]
  readonly counterfactual: boolean
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly verifySelectProofRequired: boolean
  readonly selectionInputs: SelectionInputs
  readonly selectionAuthorityContracts: SelectionContractBundle | undefined
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
  readonly verificationTarget: VerificationTargetFact | undefined
  readonly oracleFailureRepairSeed: string | undefined
  readonly mergeHint: (seed: string | undefined) => string | undefined
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly selectionBaseValidatedRed: boolean | null
  readonly chaRepairTargets: PreparedAttemptContext["chaRepairTargets"]
  readonly generationErrors: Map<number, string>
  readonly selectionLlmEvidence: Partial<LlmEvidenceArtifacts>
  readonly runtimePorts: PreparedSelectionRuntimePorts
}

const optionalSelectionRunArgs = (
  args: SelectionExecutionArgs,
  effectiveProofRequired: boolean,
): Partial<Parameters<typeof runSelection>[0]> => ({
  ...(args.verificationTarget !== undefined ? { verificationTarget: args.verificationTarget } : {}),
  ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
  ...(args.counterfactual ? { counterfactual: true } : {}),
  ...(effectiveProofRequired ? { proofRequired: true } : {}),
  ...(args.selectionAuthorityContracts !== undefined
    ? { publicContracts: args.selectionAuthorityContracts }
    : {}),
  ...(args.oracleFailureRepairSeed !== undefined
    ? { oracleFailureRepairSeed: args.oracleFailureRepairSeed }
    : {}),
})

const runSelectionExecutor = async (
  args: SelectionExecutionArgs,
): Promise<{ readonly result: SelectionResult; readonly totalTurns: number }> => {
  let totalTurns = 0
  const selectionRiskGate = buildSelectionRiskGate({
    structural: args.riskGate,
    llmMode: args.llmRiskGateMode,
    // G1 cross-vendor diversity: route the JUDGE to vendor lane 1 (distinct from
    // the cand0 generator on lane 0) when the model-lane-diversity posture is ON
    // and ≥2 lanes were injected; otherwise byte-identical (deps.llm).
    llm: resolveLaneLlm(args.deps, args.postureOverride?.modelLaneDiversity ?? false, 1),
    problemStatement: args.instance.problemStatement,
    ownerFiles: args.selectionInputs.ownerFiles,
    ownerEvidence: args.selectionOwnerEvidence,
    ...(args.instance.swebench?.repo !== undefined ? { repo: args.instance.swebench.repo } : {}),
    signal: args.signal,
  })
  // T2b — wire the PUBLIC-issue-text declared-expected port so the existing
  // clean-mode declared-expected veto can fire against message-shape inventions.
  // Gated default-OFF on `specFidelityInvariant`; the matcher's answer-key guard
  // refuses any non-public provenance, so this never sources from gold/test_patch.
  const declaredExpectedPort =
    args.postureOverride?.specFidelityInvariant === true
      ? buildPublicDeclaredExpectedPort(
          extractIssueDeclaredExpected(args.instance.problemStatement),
          // H1 dynamic-message-matcher: when on, narrow the matcher's dynamic-format
          // abstain region via fixed-skeleton comparison (default-OFF ⇒ byte-identical).
          { dynamicSkeleton: args.postureOverride?.dynamicMessageMatcher === true },
        )
      : undefined
  const { effectiveProofRequired } = computeEffectiveProofRequired(
    args.verifySelectProofRequired,
    args.runtimePorts.proofCalibration,
  )
  const result = await runSelection({
    n: args.n,
    problemStatement: args.instance.problemStatement,
    owners: args.selectionInputs.owners,
    seeds: args.selectionInputs.seeds,
    candidateFamilies: args.selectionInputs.candidateFamilies,
    resolvedKofNMode: args.runtimePorts.reproPolicy.resolvedKofNMode,
    earlyAccept: args.earlyAccept,
    mode: args.selectorMode,
    repairReadSource: readSelectionSource(args.sandbox),
    repairIssueSymbols: extractIssueHint(args.instance.problemStatement).symbols,
    repairOwnerEvidence: args.selectionOwnerEvidence,
    ...(selectionRiskGate !== undefined ? { riskGate: selectionRiskGate } : {}),
    ...optionalSelectionRunArgs(args, effectiveProofRequired),
    ...(declaredExpectedPort !== undefined ? { declaredExpectedAuthority: "public" as const } : {}),
    // T1 family-coverage veto. Default OFF; opt-in via QUANTA_BENCH_FAMILY_COVERAGE
    // (reverted as net-negative producer-consumer over-demand).
    ...(gateOn(process.env, "QUANTA_BENCH_FAMILY_COVERAGE")
      ? { familyCoverageVeto: true as const }
      : {}),
    // CORRECTED non-empty fallback. Default OFF; opt-in via
    // QUANTA_BENCH_NONEMPTY_FALLBACK. When no winner exists, submit the rock-solid-
    // subset candidate (applies clean / no regression / no static-sanity break,
    // barred only by a self-oracle) instead of empty — weakly dominates on binary
    // SWE-bench scoring. Unset ⇒ no fallbackCandidate ⇒ byte-identical.
    ...(gateOn(process.env, "QUANTA_BENCH_NONEMPTY_FALLBACK")
      ? { nonEmptyFallback: true as const }
      : {}),
    recordLlmEvidencePacket: (packet: LlmEvidencePacket) => {
      recordLlmEvidencePacket(args.selectionLlmEvidence, packet)
    },
    ports: {
      ...selectionPorts({
        instance: args.instance,
        deps: args.deps,
        sandbox: args.sandbox,
        signal: args.signal,
        wiring: args.wiring,
        precomputedHint: args.precomputedHint,
        reproHint: args.reproHint,
        postureOverride: args.postureOverride,
        stateOverride: args.stateOverride,
        mergeHint: args.mergeHint,
        concurrency: args.concurrency,
        baseValidatedRed: args.selectionBaseValidatedRed,
        generationErrors: args.generationErrors,
        chaRepairTargets: args.chaRepairTargets,
        addTurns: (turns) => {
          totalTurns += turns
        },
        staticSanitySelectionPort: args.runtimePorts.staticSanitySelectionPort,
        regressionSelectionPort: args.runtimePorts.regressionSelectionPort,
        ...(args.runtimePorts.publicRegressionProofSelectionPort !== undefined
          ? {
              publicRegressionProofSelectionPort:
                args.runtimePorts.publicRegressionProofSelectionPort,
            }
          : {}),
        ...(args.runtimePorts.smokeSelectionPort !== undefined
          ? { smokeSelectionPort: args.runtimePorts.smokeSelectionPort }
          : {}),
        ...(args.runtimePorts.mweProofSelectionPort !== undefined
          ? { mweProofSelectionPort: args.runtimePorts.mweProofSelectionPort }
          : {}),
        ...(args.runtimePorts.resolvedKofNSelectionPort !== undefined
          ? { resolvedKofNSelectionPort: args.runtimePorts.resolvedKofNSelectionPort }
          : {}),
        ...(args.runtimePorts.reproConsensusProofSelectionPort !== undefined
          ? { reproConsensusProofSelectionPort: args.runtimePorts.reproConsensusProofSelectionPort }
          : {}),
        selectorMode: args.selectorMode,
      }),
      ...(declaredExpectedPort !== undefined ? { declaredExpected: declaredExpectedPort } : {}),
    },
  })
  return { result, totalTurns }
}

const readSelectionSource = (sandbox: string): ((rel: string) => string | null) => {
  return (rel) => readSandboxSource(sandbox, rel)
}

/**
 * TD — verify-and-select phase. Generates N closure-diversity-seeded candidates
 * (candidate 0 = unbiased; candidate i>0 nudged toward the i-th ranked owner so
 * the set spans different FIX SITES) and submits the {@link runSelection} pick.
 * Each candidate is a full agent run on a fresh snapshot (`withGitSnapshot`
 * resets the tree between them). Reached ONLY when the `verify-select` knob set
 * `verifySelectN`; otherwise the single-pass path runs (byte-identical).
 */
export const runSelectionPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  n: number,
  concurrency: number | undefined,
  earlyAccept: boolean,
  riskGate: boolean,
  llmRiskGateMode: BenchPosture["verifySelectLlmRiskGate"],
  counterfactual: boolean,
  selectorMode: BenchPosture["selectorMode"],
  verifySelectProofRequired: boolean,
  publicContracts: SelectionContractBundle | undefined,
  verifySelectRegression: BenchPosture["verifySelectRegression"],
  _regressionMaxTests: number | undefined,
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  selectionOwnerCandidates: readonly string[],
  ownerResolved: PreparedAttemptContext["ownerResolved"],
  baseValidatedRed: boolean,
  verificationPlan: PreparedAttemptContext["verificationPlan"],
  existingTestExpectations: PreparedAttemptContext["existingTestExpectations"],
  reproTest: BenchReproTestTelemetry | undefined,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaRepairTargets?: PreparedAttemptContext["chaRepairTargets"],
): Promise<Phase> => {
  const selectionContext = prepareSelectionEvidenceContext({
    problemStatement: instance.problemStatement,
    sandbox,
    n,
    ownerCandidates: selectionOwnerCandidates,
    ownerResolved,
    publicContracts,
    verifySelectRegression,
    baseValidatedRed,
    reproHint,
    reproTest,
    verificationTarget: verificationTargetFromPlan(verificationPlan),
    oracleFailureRepairSeed: validatedReproRepairSeed(reproSources),
    existingTestExpectations,
    readSource: readSelectionSource(sandbox),
  })
  const {
    selectionInputs,
    selectionAuthorityContracts,
    advisoryPromptContracts,
    selectionOwnerEvidence,
    verificationTarget,
    existingTestExpectations: selectionExistingTestExpectations,
    staticWitnessDiagnostics,
    selectionBaseValidatedRed,
    generationEnvCaveats,
    oracleFailureRepairSeed,
  } = selectionContext
  const generationErrors = new Map<number, string>()
  const selectionLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  const mergeHint = (seed: string | undefined): string | undefined =>
    composeSelectionAgentHint(
      {
        verifySelectProofRequired,
        selectorMode,
        problemStatement: instance.problemStatement,
        ownerEvidence: selectionOwnerEvidence,
        promptContracts: advisoryPromptContracts,
        baseValidatedRed: selectionBaseValidatedRed,
        ...(verificationTarget !== undefined ? { verificationTarget } : {}),
        ...(reproHint !== undefined ? { reproHint } : {}),
        validatedReproScripts: reproSources,
        existingTestExpectations: selectionExistingTestExpectations,
        ...(closureHint !== undefined ? { closureHint } : {}),
        envCaveats: generationEnvCaveats,
        staticWitnessDiagnostics,
        recordLlmEvidencePacket: (packet) => {
          recordLlmEvidencePacket(selectionLlmEvidence, packet)
        },
      },
      seed,
    )

  const runtimePorts = await prepareSelectionRuntimePorts({
    instance,
    sandbox,
    timeoutMs: deps.timeoutMs,
    reproSources,
    verifySelectRepro,
    verifySelectProofRequired,
    verifySelectRegression,
    selectorMode,
  })
  const { result, totalTurns } = await runSelectionExecutor({
    instance,
    deps,
    sandbox,
    signal,
    wiring: w,
    n,
    concurrency,
    earlyAccept,
    riskGate,
    llmRiskGateMode,
    counterfactual,
    selectorMode,
    verifySelectProofRequired,
    selectionInputs,
    selectionAuthorityContracts,
    selectionOwnerEvidence,
    verificationTarget,
    oracleFailureRepairSeed,
    mergeHint,
    precomputedHint,
    reproHint,
    postureOverride,
    stateOverride,
    selectionBaseValidatedRed,
    generationErrors,
    selectionLlmEvidence,
    chaRepairTargets: chaRepairTargets ?? [],
    runtimePorts,
  })
  const reportCalibration = runtimePorts.proofCalibration.available
    ? runtimePorts.proofCalibration
    : runtimePorts.calibration
  return selectionPhaseFromResult({
    result,
    generationErrors,
    totalTurns,
    n,
    calibration: reportCalibration,
    llmEvidence: selectionLlmEvidence,
  })
}

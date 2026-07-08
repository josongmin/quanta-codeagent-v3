/**
 * Verify-SELECT phase orchestration (pure code motion from `driver.ts`,
 * byte-identical). Owns the repro-consensus selection POLICY resolution, the
 * per-candidate generation + sandbox lifecycle, the selection executor port
 * assembly, and `runSelectionPhase` (the best-of-N generate→score→select loop).
 * Depends on the extracted agent-phase runner + candidate-family ports +
 * selection-port factories + config-build; the shared vocabulary comes from
 * `./context-types`. No cycle back into the driver orchestration root.
 */

import { extractIssueHint } from "@/agent"
import type { OwnerSibling } from "@/agent/closure"
import { evictLspWorkspaces } from "@/agent/lsp-bridge"
import { type LLMPort, laneLabeledPort } from "@/llm"
import { gateOn } from "@/shared"
import type { BenchReproTestTelemetry, Instance, ReproOracleCalibration } from "../../types"
import type { ChaRepairTarget } from "../cha-multisite"
import type { ClosureSessionState } from "../closure-session"
import { coeditFamilyCoverageCandidate } from "../family-coverage-coedit"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "../knobs-bench"
import { laneProgress, laneProgressPort } from "../lane-progress"
import {
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  recordLlmEvidencePacket,
  type SelectionGenerationPromptInput,
  type VerificationTargetFact,
  verificationTargetFromPlan,
} from "../llm-evidence-packet"
import { prepareMweProofSelectionPort } from "../mwe-proof-port"
import type { SelectionContractBundle } from "../public-contract-types"
import { candidatePatchAppliesCleanly } from "../rematerialize"
import { makePatchedResolvedConsensus } from "../repair/resolved-consensus"
import {
  makeDiscoveredRepoRegressionPort,
  makeDiscoveredRepoRegressionProofPort,
} from "../repo-regression-discovery-adapter"
import type { Wiring } from "../report"
import {
  calibrateReproOracle,
  unavailableReproOracleCalibration,
} from "../repro-oracle-calibration"
import { cleanupSandbox, forkSandbox } from "../sandbox"
import { composeSelectionAgentHint, prepareSelectionEvidenceContext } from "../selection-assembly"
import {
  type Candidate,
  filesFromPatch,
  runSelection,
  type SelectionPorts,
  summarizeSelection,
} from "../selection-executor"
import { selectionGenerationErrorOf } from "../selection-generation-error"
import { buildSelectionRiskGate } from "../selection-risk-gate"
import { prepareIssueSmokeSelectionPort } from "../selection-smoke"
import type { StaticWitnessDiagnostic } from "../static-witness-adapter"
import { runAgentPhase } from "./agent-phase"
import {
  deriveCandidateStructuralRepair,
  makeSelectionRegressionPort,
  makeSelectionStaticSanityPort,
} from "./candidate-family-ports"
import { type Phase, type RunInstanceDeps, readSandboxSource } from "./context-types"
import { validatedReproRepairSeed } from "./repro-test-prep"
import {
  makeCalibratedReproConsensusPort,
  makeReproConsensusProofSelectionPort,
  makeReproConsensusSelectionPort,
  reproExecBundle,
} from "./selection-port-factories"

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

/**
 * P4 (jun-23): GOLD-calibrate the PROOF-REQUIRED gate's CANONICAL oracle.
 *
 * Defect 2 root cause: `makeCalibratedReproConsensusPort` fail-opens the SOFT
 * `resolvedKofN` selection port when the oracle is a confirmed gold false-negative,
 * but the HARD proof gate (`makeReproConsensusProofSelectionPort` →
 * `applyProofRequiredHardGate`) had NO calibration — a proven-broken (gold-FN)
 * oracle still held hard submit authority and WITHHELD the correct candidate. And
 * in `verify-select-repro: positive` (soft) mode the gold calibration NEVER RAN,
 * so the proof gate ran fully blind.
 *
 * This runs the SAME canonical consensus probe used by the proof gate against the
 * GOLD patch (EVAL-ONLY) so the driver can LIFT proofRequired for this instance
 * when the canonical oracle is a confirmed gold-FN — a proven-broken oracle must
 * never hold hard submit authority. Mirrors the soft-port calibration step in
 * {@link makeCalibratedReproConsensusPort}, but for the proof path. Returns an
 * UNAVAILABLE (no-claim) calibration when there is no reproducing canonical set
 * (the gate is inert) or no gold (off-bench). */
const calibrateProofOracle = async (
  instance: Instance,
  canonicalReproSources: readonly string[],
  sandbox: string,
  timeoutMs: number,
): Promise<ReproOracleCalibration> => {
  if (canonicalReproSources.length === 0) return unavailableReproOracleCalibration()
  const probe = makePatchedResolvedConsensus({
    sources: canonicalReproSources,
    ...reproExecBundle(instance),
  })
  return calibrateReproOracle({
    resolvedProbe: probe,
    goldPatch: instance.goldPatch,
    sandbox,
    baseCommit: instance.swebench?.baseCommit,
    ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
    timeoutMs,
  })
}

/**
 * P4 PROOF-GATE FAIL-OPEN decision (THE structural fix for Defect 2) — pure +
 * exported for direct mutation-grade testing of the EXACT decision the selection
 * phase makes.
 *
 * A proof-required submit gate built on a CONFIRMED gold false-negative canonical
 * oracle would WITHHOLD the canonical-correct fix forever: the broken oracle can
 * never report a resolved sidecar, so `applyProofRequiredHardGate` rejects every
 * candidate. A proven-broken oracle must NOT hold hard submit authority ⇒ LIFT
 * proofRequired for this instance (mirror of the soft-port fail-open in
 * {@link makeCalibratedReproConsensusPort}). When the oracle is trustworthy
 * (not gold-FN) OR proof was never required, the gate is unchanged.
 *
 * `proofCalibration.falseNegative` is gold-derived telemetry (EVAL-ONLY) — it
 * flips a HARNESS submit gate only; it never reaches the agent or any prompt.
 */
export const computeEffectiveProofRequired = (
  verifySelectProofRequired: boolean,
  proofCalibration: ReproOracleCalibration,
): { effectiveProofRequired: boolean; proofGateFailOpen: boolean } => {
  // A proven-broken canonical oracle must NOT hold hard submit authority. Two
  // gold-calibrated failure modes both fail the gate OPEN (lift proofRequired):
  //   - `falseNegative` (P4): the oracle stays RED on the canonical-correct GOLD
  //     fix ⇒ it would withhold every correct candidate (too strict).
  //   - `vacuous` (P3): the oracle reports GREEN on the un-patched BASE tree ⇒ its
  //     "green" is meaningless and would false-GREEN a wrong candidate (too loose);
  //     a meaningless proof can't be trusted to gate, so don't require it.
  const proofGateFailOpen =
    verifySelectProofRequired &&
    (proofCalibration.falseNegative || (proofCalibration.vacuous ?? false))
  return {
    effectiveProofRequired: verifySelectProofRequired && !proofGateFailOpen,
    proofGateFailOpen,
  }
}

export const familyCoverageCoeditEnabled = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_BENCH_FAMILY_COVERAGE_COEDIT")

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
  // P4: when the proof gate is active, ALWAYS gold-calibrate its canonical oracle
  // — independent of `goldCalibrate` (soft `positive` mode also has a proof gate).
  // `reproSources` here is the CANONICAL submit-gate set (hardening is excluded
  // upstream by `reproducingReproSources`), so calibration is on the right set.
  const proofCalibration = proofRequired
    ? await calibrateProofOracle(instance, reproSources, sandbox, timeoutMs)
    : calibrationUnavailable
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
      // The hard-mode soft-port calibration already probed gold on the same
      // canonical set; prefer it (it carries goldVotes/goldK). The dedicated
      // proof calibration is the fallback for the soft `positive` path.
      calibration,
      proofCalibration: calibration.available ? calibration : proofCalibration,
    }
  }
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

/**
 * G1 cross-vendor diversity — resolve the LLM port that should GENERATE
 * verify-select candidate `index`. Pure (no I/O), so the lane→provider routing
 * is unit-testable in isolation.
 *
 * Routing rule: `lanes[index mod lanes.length]` — index-modulo only, NO issue /
 * gold / answer-key inspection. Diversity comes from the structural fan-out, not
 * from peeking at the task. The mapping is the SAME stable round-robin every run.
 *
 * Returns `deps.llm` UNCHANGED (the single-vendor path) whenever:
 *   - the `model-lane-diversity` posture is OFF, OR
 *   - `deps.llmLanes` is absent / has fewer than 2 distinct lanes
 * so an unconfigured environment is byte-identical to the pre-feature driver.
 */
export const resolveLaneLlm = (
  deps: Pick<RunInstanceDeps, "llm" | "llmLanes">,
  modelLaneDiversity: boolean,
  index: number,
): LLMPort => {
  if (!modelLaneDiversity) return deps.llm
  const lanes = deps.llmLanes
  if (lanes === undefined || lanes.length < 2) return deps.llm
  const lane = lanes[((index % lanes.length) + lanes.length) % lanes.length]
  return lane ?? deps.llm
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
  readonly chaMultisiteSteer: string | undefined
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
  // Label this candidate's turns so N concurrent verify-select lanes stay
  // distinguishable on the one shared recording tape (replay-neutral).
  // laneProgressPort adds LIVE per-turn/-tool progress emission (display-only).
  const lane = `verify-select#${args.index}`
  laneProgress.emit({ kind: "start", lane })
  let laneOk = false
  let lanePatchBytes = 0
  const laneLlm = laneProgressPort(
    laneLabeledPort(resolveLaneLlm(args.deps, lanePosture.modelLaneDiversity, args.index), lane),
    lane,
  )
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
      args.chaMultisiteSteer,
      laneLlm,
    )
    args.addTurns(phase.turns)
    lanePatchBytes = phase.patch?.length ?? 0
    const generationError = selectionGenerationErrorOf({
      stopReason: phase.stopReason,
      patch: phase.patch,
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
    })
    if (generationError !== undefined) {
      args.generationErrors.set(args.index, generationError)
      throw new Error(generationError)
    }
    laneOk = true
    return {
      id: `cand-${args.index}`,
      patch: phase.patch,
      turns: phase.turns,
      files: filesFromPatch(phase.patch),
      baseValidatedRed: args.baseValidatedRed,
      sandboxPath: candidateSandbox,
      ...(phase.stopReason !== undefined ? { stopReason: phase.stopReason } : {}),
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
      ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
      ...(phase.sourceAppliedEditCount !== undefined
        ? { sourceAppliedEditCount: phase.sourceAppliedEditCount }
        : {}),
    }
  } finally {
    laneProgress.emit({ kind: "done", lane, ok: laneOk, patchBytes: lanePatchBytes })
    if (isolated) await cleanupSelectionCandidateSandbox(candidateSandbox)
  }
}

export const cleanupSelectionCandidateSandbox = async (
  sandbox: string,
  deps: {
    readonly evictLspWorkspaces?: (cwd: string) => Promise<void>
    readonly cleanupSandbox?: (sandbox: string) => Promise<void>
  } = {},
): Promise<void> => {
  const evict = deps.evictLspWorkspaces ?? evictLspWorkspaces
  const cleanup = deps.cleanupSandbox ?? cleanupSandbox
  await evict(sandbox).catch(() => undefined)
  await cleanup(sandbox)
}

const resolveSelectionPhasePorts = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly riskGate: boolean
  readonly llmRiskGateMode: BenchPosture["verifySelectLlmRiskGate"]
  /** G1 cross-vendor diversity: when ON (and ≥2 lanes injected) the LLM
   *  risk-gate JUDGE is routed to vendor lane 1 — a DIFFERENT vendor than the
   *  cand0 generator (lane 0) — so the judge is decorrelated from the generator
   *  it scores. OFF ⇒ judge stays on `deps.llm` (byte-identical). */
  readonly modelLaneDiversity: boolean
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly verifySelectRepro: BenchPosture["verifySelectRepro"]
  readonly verifySelectProofRequired: boolean
  readonly regressionMaxTests: number | undefined
  readonly reproSources: readonly string[]
  readonly baseValidatedRed: boolean
  readonly selectionOwnerCandidates: readonly string[]
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
}) => {
  const {
    reproPolicy,
    resolvedKofNSelectionPort,
    reproConsensusProofSelectionPort,
    calibration,
    proofCalibration,
  } = await resolveSelectionReproConsensus(
    args.instance,
    args.sandbox,
    args.deps.timeoutMs,
    args.reproSources,
    args.verifySelectRepro,
    args.verifySelectProofRequired,
  )
  const regressionMaxTests =
    args.regressionMaxTests !== undefined ? { maxTests: args.regressionMaxTests } : {}
  const discoveredRegressionPort =
    args.verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.deps.timeoutMs,
          ...regressionMaxTests,
        })
      : undefined
  const publicRegressionProofSelectionPort =
    args.verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionProofPort({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.deps.timeoutMs,
          ...regressionMaxTests,
        })
      : undefined
  const regressionSelectionPort = makeSelectionRegressionPort({
    verifySelectRegression: args.verifySelectRegression,
    discoveredRegressionPort,
    instance: args.instance,
    sandbox: args.sandbox,
    timeoutMs: args.deps.timeoutMs,
  })
  const staticSanitySelectionPort = makeSelectionStaticSanityPort({
    sandbox: args.sandbox,
    baseCommit: args.instance.swebench?.baseCommit,
    timeoutMs: args.deps.timeoutMs,
  })
  const smokeSelectionPort = await prepareIssueSmokeSelectionPort(
    args.instance,
    args.sandbox,
    args.deps.timeoutMs,
  )
  const mweProofSelectionPort =
    args.selectorMode === "clean"
      ? await prepareMweProofSelectionPort(args.instance, args.sandbox, args.deps.timeoutMs)
      : undefined
  const selectionRiskGate = buildSelectionRiskGate({
    structural: args.riskGate,
    llmMode: args.llmRiskGateMode,
    // G1: route the JUDGE to vendor lane 1 (distinct from the cand0 generator on
    // lane 0) when diversity is ON, so generation and judging are cross-vendor.
    llm: resolveLaneLlm(args.deps, args.modelLaneDiversity, 1),
    problemStatement: args.instance.problemStatement,
    ownerFiles: args.selectionOwnerCandidates,
    ownerEvidence: args.selectionOwnerEvidence,
    ...(args.instance.swebench?.repo !== undefined ? { repo: args.instance.swebench.repo } : {}),
    signal: args.signal,
  })
  return {
    reproPolicy,
    resolvedKofNSelectionPort,
    calibration,
    proofCalibration,
    regressionSelectionPort,
    publicRegressionProofSelectionPort,
    reproConsensusProofSelectionPort,
    staticSanitySelectionPort,
    smokeSelectionPort,
    mweProofSelectionPort,
    selectionBaseValidatedRed:
      args.verifySelectRegression === "discovered" ? null : args.baseValidatedRed,
    selectionRiskGate,
  }
}

type SelectionExecutorPortsArgs = {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly verifySelectProofRequired: boolean
  readonly wiring: Wiring
  readonly precomputedHint: string | undefined
  readonly reproHint: string | undefined
  readonly closureHint: string | undefined
  readonly postureOverride: BenchPosture | undefined
  readonly stateOverride: BenchKnobState | undefined
  readonly chaMultisiteSteer: string | undefined
  readonly chaRepairTargets: readonly ChaRepairTarget[]
  /** jun-25: CHA contract-fallback sibling mode for the selection-time structural
   *  repair port. "general" only when `cha-multisite-general` is on. */
  readonly chaSiblingMode: "path-hardcoded" | "general"
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
  readonly envCaveats: readonly string[]
  readonly validatedReproScripts: readonly string[]
  readonly existingTestExpectations: readonly string[]
  readonly staticWitnessDiagnostics: readonly StaticWitnessDiagnostic[]
  readonly promptContracts: SelectionContractBundle | undefined
  readonly verificationTarget: VerificationTargetFact | undefined
  readonly recordLlmEvidencePacket: ((packet: LlmEvidencePacket) => void) | undefined
  readonly concurrency: number | undefined
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
  readonly baseValidatedRed: boolean | null
  readonly staticSanitySelectionPort: NonNullable<SelectionPorts["staticSanity"]>
  readonly regressionSelectionPort: NonNullable<SelectionPorts["regression"]>
  readonly publicRegressionProofSelectionPort: SelectionPorts["publicRegressionProof"]
  readonly smokeSelectionPort: SelectionPorts["smoke"]
  readonly mweProofSelectionPort: SelectionPorts["mweProof"]
  readonly resolvedKofNSelectionPort: SelectionPorts["resolvedKofN"]
  readonly reproConsensusProofSelectionPort: SelectionPorts["reproConsensusProof"]
}

const generateSelectionPort =
  (args: SelectionExecutorPortsArgs) => (index: number, seed?: string) =>
    generateSelectionCandidate({
      index,
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
      chaMultisiteSteer: args.chaMultisiteSteer,
      mergeHint: (seedHint) =>
        composeSelectionAgentHint(
          {
            verifySelectProofRequired: args.verifySelectProofRequired,
            selectorMode: args.selectorMode,
            problemStatement: args.instance.problemStatement,
            ownerEvidence: args.selectionOwnerEvidence,
            promptContracts: args.promptContracts,
            baseValidatedRed: args.baseValidatedRed,
            ...(args.verificationTarget !== undefined
              ? { verificationTarget: args.verificationTarget }
              : {}),
            ...(args.reproHint !== undefined ? { reproHint: args.reproHint } : {}),
            validatedReproScripts: args.validatedReproScripts,
            existingTestExpectations: args.existingTestExpectations,
            ...(args.closureHint !== undefined ? { closureHint: args.closureHint } : {}),
            envCaveats: args.envCaveats,
            staticWitnessDiagnostics: args.staticWitnessDiagnostics,
            ...(args.recordLlmEvidencePacket !== undefined
              ? { recordLlmEvidencePacket: args.recordLlmEvidencePacket }
              : {}),
          },
          seedHint,
        ),
      concurrency: args.concurrency,
      baseValidatedRed: args.baseValidatedRed,
      generationErrors: args.generationErrors,
      addTurns: args.addTurns,
    })

const buildSelectionExecutorPorts = (args: SelectionExecutorPortsArgs): SelectionPorts => {
  const ports: SelectionPorts = {
    generate: generateSelectionPort(args),
    applyClean: (candidate) =>
      candidatePatchAppliesCleanly({
        sandbox: args.sandbox,
        patch: candidate.patch,
        baseCommit: args.instance.swebench?.baseCommit,
        timeoutMs: args.deps.timeoutMs,
      }),
    staticSanity: args.staticSanitySelectionPort,
    regression: args.regressionSelectionPort,
  }
  if (args.smokeSelectionPort !== undefined) ports.smoke = args.smokeSelectionPort
  if (args.mweProofSelectionPort !== undefined) ports.mweProof = args.mweProofSelectionPort
  if (args.publicRegressionProofSelectionPort !== undefined)
    ports.publicRegressionProof = args.publicRegressionProofSelectionPort
  if (args.resolvedKofNSelectionPort !== undefined)
    ports.resolvedKofN = args.resolvedKofNSelectionPort
  if (args.reproConsensusProofSelectionPort !== undefined)
    ports.reproConsensusProof = args.reproConsensusProofSelectionPort
  if (args.selectorMode === "clean") {
    ports.deriveCandidateStructuralRepair = (candidate) =>
      deriveCandidateStructuralRepair({
        instance: args.instance,
        candidate,
        sandbox: args.sandbox,
        signal: args.signal,
        preferredTargets: args.chaRepairTargets,
        siblingMode: args.chaSiblingMode,
      })
    if (familyCoverageCoeditEnabled(process.env)) {
      ports.repairFamilyCoverage = ({ candidate, family, missingFiles }) =>
        coeditFamilyCoverageCandidate({
          sandbox: args.sandbox,
          candidate,
          family,
          missingFiles,
          timeoutMs: args.deps.timeoutMs,
          baseCommit: args.instance.swebench?.baseCommit,
          repo: args.instance.swebench?.repo,
          preferredTargets: args.chaRepairTargets,
        })
    }
  }
  return ports
}

const selectionGenerationFailurePhase = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly calibration: ReproOracleCalibration | undefined
}): Phase | undefined => {
  if (args.result.successfulGenerations > 0 || args.result.generationFailures === 0)
    return undefined
  const orderedErrors = [...args.generationErrors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, error]) => error)
  const sample = orderedErrors.slice(0, 2).join("; ")
  return {
    patch: "",
    turns: args.totalTurns,
    stopReason: "error",
    agentError:
      "agent stopped with error before verification: " +
      `verify-select candidate generation failed for all ${args.n} candidates` +
      (sample === "" ? "" : ` (${sample})`),
    selectionTelemetry:
      orderedErrors.length === 0
        ? summarizeSelection(args.result)
        : {
            ...summarizeSelection(args.result),
            generationFailureSamples: orderedErrors.slice(0, 2),
          },
    ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
  }
}

const selectionPhaseResultOf = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly calibration: ReproOracleCalibration | undefined
}): Phase => {
  const orderedErrors = [...args.generationErrors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, error]) => error)
  const phase: Phase = {
    patch: args.result.winner?.patch ?? args.result.fallbackCandidate?.patch ?? "",
    turns: args.totalTurns,
    selectionTelemetry:
      orderedErrors.length === 0
        ? summarizeSelection(args.result)
        : {
            ...summarizeSelection(args.result),
            generationFailureSamples: orderedErrors.slice(0, 2),
          },
    ...(args.calibration !== undefined ? { reproOracleCalibration: args.calibration } : {}),
  }
  if (args.result.terminalCandidate?.stopReason !== undefined)
    phase.stopReason = args.result.terminalCandidate.stopReason
  if (args.result.terminalCandidate?.agentError !== undefined)
    phase.agentError = args.result.terminalCandidate.agentError
  if (args.result.terminalCandidate?.editCount !== undefined)
    phase.editCount = args.result.terminalCandidate.editCount
  if (args.result.terminalCandidate?.sourceAppliedEditCount !== undefined)
    phase.sourceAppliedEditCount = args.result.terminalCandidate.sourceAppliedEditCount
  return phase
}

// P4 RECORD assembly: build the terminal {@link Phase} from a completed
// {@link runSelection}. Prefers the dedicated `proofCalibration` (soft `positive`
// path only ran that one) over the hard-mode `calibration`; this is EVAL-ONLY
// telemetry, never an inference-time gate. Returns the generation-failure phase
// when every candidate failed to generate, else the winner phase (with any
// accumulated LLM evidence attached). Extracted verbatim from runSelectionPhase.
const finalizeSelectionPhase = (args: {
  readonly result: Awaited<ReturnType<typeof runSelection>>
  readonly generationErrors: Map<number, string>
  readonly totalTurns: number
  readonly n: number
  readonly proofCalibration: ReproOracleCalibration
  readonly calibration: ReproOracleCalibration
  readonly selectionLlmEvidence: Partial<LlmEvidenceArtifacts>
}): Phase => {
  const reportCalibration = args.proofCalibration.available
    ? args.proofCalibration
    : args.calibration
  const generationFailure = selectionGenerationFailurePhase({
    result: args.result,
    generationErrors: args.generationErrors,
    totalTurns: args.totalTurns,
    n: args.n,
    calibration: reportCalibration,
  })
  if (generationFailure !== undefined) return generationFailure
  const phase = selectionPhaseResultOf({
    result: args.result,
    generationErrors: args.generationErrors,
    totalTurns: args.totalTurns,
    calibration: reportCalibration,
  })
  if (Object.keys(args.selectionLlmEvidence).length > 0)
    phase.llmEvidence = args.selectionLlmEvidence
  return phase
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
  regressionMaxTests: number | undefined,
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  selectionOwnerCandidates: readonly string[],
  ownerResolved: readonly OwnerSibling[] | undefined,
  baseValidatedRed: boolean,
  verificationPlan: ClosureSessionState["bundle"]["plan"] | undefined,
  existingTestExpectations: readonly string[],
  reproTest: BenchReproTestTelemetry | undefined,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
  hardeningReproSources: readonly string[],
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaMultisiteSteer?: string,
  chaRepairTargets?: readonly ChaRepairTarget[],
): Promise<Phase> => {
  // jun-23 split: ADVISORY repair seed = canonical (submit-gate) scripts FIRST,
  // then any hardening scripts as extra coverage guidance. Hardening NEVER gates
  // submit; it only seeds repair / breaks ties. Canonical-only ⇒ byte-identical.
  const oracleFailureRepairSeed = validatedReproRepairSeed([
    ...reproSources,
    ...hardeningReproSources,
  ])
  const generationErrors = new Map<number, string>()
  const selectionLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
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
    oracleFailureRepairSeed,
    existingTestExpectations,
    readSource: (rel) => readSandboxSource(sandbox, rel),
  })
  const {
    advisoryPromptContracts,
    selectionAuthorityContracts,
    selectionInputs,
    selectionOwnerEvidence,
    verificationTarget,
    existingTestExpectations: selectionExistingTestExpectations,
    staticWitnessDiagnostics,
    generationEnvCaveats,
  } = selectionContext
  let totalTurns = 0
  const selectionState = await resolveSelectionPhasePorts({
    instance,
    deps,
    sandbox,
    signal,
    selectorMode,
    riskGate,
    llmRiskGateMode,
    modelLaneDiversity: postureOverride?.modelLaneDiversity ?? false,
    verifySelectRegression,
    regressionMaxTests,
    verifySelectRepro,
    verifySelectProofRequired,
    reproSources,
    baseValidatedRed,
    selectionOwnerCandidates,
    selectionOwnerEvidence,
  })
  // P4 PROOF-GATE FAIL-OPEN (THE structural fix for Defect 2): when the CANONICAL
  // repro oracle is a CONFIRMED gold false-negative, a proof-required gate built on
  // it would WITHHOLD the canonical-correct fix (the proven-broken oracle can never
  // report a resolved sidecar, so `applyProofRequiredHardGate` rejects every candidate).
  // A proven-broken oracle must NOT hold hard submit authority ⇒ LIFT proofRequired
  // for this instance. This is the EXACT decision point (mirror of the soft-port
  // fail-open in makeCalibratedReproConsensusPort). Gold is EVAL-ONLY telemetry — it
  // never reaches the agent or any prompt; this only flips a harness submit gate.
  const { effectiveProofRequired } = computeEffectiveProofRequired(
    verifySelectProofRequired,
    selectionState.proofCalibration,
  )
  const result = await runSelection({
    n,
    problemStatement: instance.problemStatement,
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    // jun-23 W2-2 (B1): thread the slice reader + public issue symbols so the
    // SELECTOR repair packet carries the real owner source slice (engage), not a
    // path-only stub — mirrors the generation/classic-repair owner evidence.
    repairReadSource: (rel) => readSandboxSource(sandbox, rel),
    repairIssueSymbols: extractIssueHint(instance.problemStatement).symbols,
    repairOwnerEvidence: selectionOwnerEvidence,
    owners: selectionInputs.owners,
    seeds: selectionInputs.seeds,
    candidateFamilies: selectionInputs.candidateFamilies,
    resolvedKofNMode: selectionState.reproPolicy.resolvedKofNMode,
    earlyAccept,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(selectionState.selectionRiskGate !== undefined
      ? { riskGate: selectionState.selectionRiskGate }
      : {}),
    ...(counterfactual ? { counterfactual: true } : {}),
    mode: selectorMode,
    ...(effectiveProofRequired ? { proofRequired: true } : {}),
    ...(selectionAuthorityContracts !== undefined
      ? { publicContracts: selectionAuthorityContracts }
      : {}),
    ...(oracleFailureRepairSeed !== undefined ? { oracleFailureRepairSeed } : {}),
    // CORRECTED non-empty fallback. Default OFF; opt-in via
    // QUANTA_BENCH_NONEMPTY_FALLBACK. When no winner exists, submit the rock-solid-
    // subset candidate (applies clean / no regression / no static-sanity break,
    // barred only by a self-oracle) instead of empty — weakly dominates on binary
    // SWE-bench scoring. Unset ⇒ no fallbackCandidate ⇒ byte-identical.
    ...(gateOn(process.env, "QUANTA_BENCH_NONEMPTY_FALLBACK")
      ? { nonEmptyFallback: true as const }
      : {}),
    recordLlmEvidencePacket: (packet) => {
      recordLlmEvidencePacket(selectionLlmEvidence, packet)
    },
    ports: buildSelectionExecutorPorts({
      instance,
      deps,
      sandbox,
      signal,
      selectorMode,
      wiring: w,
      precomputedHint,
      reproHint,
      closureHint,
      postureOverride,
      stateOverride,
      chaMultisiteSteer,
      chaRepairTargets: chaRepairTargets ?? [],
      chaSiblingMode: postureOverride?.chaMultisiteGeneral ? "general" : "path-hardcoded",
      concurrency,
      generationErrors,
      addTurns: (turns) => {
        totalTurns += turns
      },
      baseValidatedRed: selectionState.selectionBaseValidatedRed,
      staticSanitySelectionPort: selectionState.staticSanitySelectionPort,
      regressionSelectionPort: selectionState.regressionSelectionPort,
      publicRegressionProofSelectionPort: selectionState.publicRegressionProofSelectionPort,
      smokeSelectionPort: selectionState.smokeSelectionPort,
      mweProofSelectionPort: selectionState.mweProofSelectionPort,
      resolvedKofNSelectionPort: selectionState.resolvedKofNSelectionPort,
      reproConsensusProofSelectionPort: selectionState.reproConsensusProofSelectionPort,
      verifySelectProofRequired,
      selectionOwnerEvidence,
      envCaveats: generationEnvCaveats,
      validatedReproScripts: reproSources,
      existingTestExpectations: selectionExistingTestExpectations,
      staticWitnessDiagnostics,
      promptContracts: advisoryPromptContracts,
      verificationTarget,
      recordLlmEvidencePacket: (packet) => {
        recordLlmEvidencePacket(selectionLlmEvidence, packet)
      },
    }),
  })
  return finalizeSelectionPhase({
    result,
    generationErrors,
    totalTurns,
    n,
    proofCalibration: selectionState.proofCalibration,
    calibration: selectionState.calibration,
    selectionLlmEvidence,
  })
}

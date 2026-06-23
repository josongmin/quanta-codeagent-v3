import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type AgentConfig, type AgentOutcome, runAgent, wireOptionalAgentPorts } from "@/agent"
import { evaluateSuccessPredicate, type PrimaryRailStep } from "@/agent/closure"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { extractIssueHint } from "@/agent/issue-hint"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import type { Message } from "@/llm"
import type { CapabilityManifest, SessionEvent } from "@/protocol/session"
import { withStaticWitnessFamilies } from "@/runner/batch/eval/candidate-families"
import { runAdaptiveBenchAttempt } from "@/runner/batch/eval/adaptive-escalation"
import { makeAdaptiveToolModelCall } from "@/runner/batch/eval/adaptive-escalation/live-model-call"
import {
  applyBenchKnobs,
  type BenchKnobState,
  BenchObserver,
  type BenchPosture,
  benchOptIns,
  benchVerifyAuthorityCommandsOf,
  buildAdaptivePhasePacket,
  buildReproVoteValidate,
  buildConfig as buildRunnerConfig,
  buildSelectionCandidateFamilyBundle,
  composeWithReproHint,
  DEFAULT_POLICY,
  deriveCandidateStructuralRepair,
  emitKnobsApplied,
  enumerateRepoSources,
  envPrepFailedResult,
  type IssueHintMode,
  knobsForReport,
  latePhaseFailureResultOf,
  makeCalibratedReproConsensusPort,
  makeReproConsensusProofSelectionPort,
  makeReproConsensusSelectionPort,
  makeSelectionRegressionPort,
  makeSelectionStaticSanityPort,
  maybeValidateTerminalResult,
  type PreparedAttemptContext,
  type PrepareIssueHintDeps,
  type PrepareReproTestDeps,
  parseBenchBranchSearchK,
  parseBenchReproTestK,
  parseLocalizePhaseEnv,
  prepareAttemptContext,
  prepareIssueHint,
  prepareReproTest,
  prepareReproTestDetailed,
  prepareSelectionReproSources,
  projectOutcome,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  runRetryLoop,
  type RunInstanceDeps as SharedRunInstanceDeps,
  StrictLspGroundingDegradedError,
  selectionReproPrepK,
  selectionGenerationEnvCaveats,
  UsageTap,
  validatedReproRepairSeed,
  verifyAndFinalizeResult,
  withCandidateFamilyPublicContracts,
} from "@/runner/batch/eval/driver"
import {
  buildSelectionOwnerEvidence,
  buildSelectionGenerationPrompt,
  type ContractFact,
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  PacketBlindnessViolation,
  recordLlmEvidencePacket,
  verificationTargetFromPlan,
} from "@/runner/batch/eval/llm-evidence-packet"
import { prepareMweProofSelectionPort } from "@/runner/batch/eval/mwe-proof-port"
import { buildCleanSelectionPublicContracts } from "@/runner/batch/eval/public-contract-bundle"
import type { PublicContractBundle } from "@/runner/batch/eval/public-contract-types"
import { candidatePatchAppliesCleanly } from "@/runner/batch/eval/rematerialize"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
} from "@/runner/batch/eval/repair-phase-policy"
import {
  makeDiscoveredRepoRegressionPort,
  makeDiscoveredRepoRegressionProofPort,
} from "@/runner/batch/eval/repo-regression-discovery-adapter"
import {
  buildSelectionInputs,
  type Candidate,
  filesFromPatch,
  runSelection,
  type SelectionTelemetry,
  summarizeSelection,
} from "@/runner/batch/eval/selection-executor"
import { selectionGenerationErrorOf } from "@/runner/batch/eval/selection-generation-error"
import { buildSelectionRiskGate } from "@/runner/batch/eval/selection-risk-gate"
import { prepareIssueSmokeSelectionPort } from "@/runner/batch/eval/selection-smoke"
import { buildAstStaticWitnesses } from "@/runner/batch/eval/static-witness-adapter"
import { buildStaticWitnessContracts } from "@/runner/batch/eval/static-witness-contracts"
import { BenchStreamTap, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import { createTentativeRecorder } from "@/runner/batch/eval/tentative-patch"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateDisabled, logger } from "@/shared"
import type {
  BenchReproTestTelemetry,
  Instance,
  InstanceResult,
  ReproOracleCalibration,
} from "../types"
import { v5AdaptiveEnabled } from "../preset"
import { runEnvPrep } from "./env-prep"
import { exec } from "./exec"
import { runRepairRounds } from "./repair/index"
import { buildRepairRoundSeedMessage } from "./repair/llm-evidence"
import type { RunOnceResult } from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import { buildWiring, emitSandbox, NullStream, ObservationError, type Wiring } from "./report"
import { cleanupSandbox, copyRepo, createSandbox, forkSandbox } from "./sandbox"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"

export type { BenchKnobState, IssueHintMode, PrepareIssueHintDeps, PrepareReproTestDeps }
export {
  applyBenchKnobs,
  BenchObserver,
  benchInstallsReproHint,
  benchOptIns,
  benchRunsRepairPhase,
  buildRunnerConfig as buildConfig,
  composeWithReproHint,
  enumerateRepoSources,
  knobsForReport,
  parseBenchBranchSearchK,
  parseBenchReproTestK,
  parseLocalizePhaseEnv,
  prepareIssueHint,
  prepareReproTest,
  prepareReproTestDetailed,
  prepareSelectionReproSources,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  selectionReproPrepK,
  UsageTap,
}

export interface RunInstanceDeps extends SharedRunInstanceDeps {
  readonly runtimeFactory?: typeof createRuntime
}

const capabilityManifestForConfig = (config: AgentConfig): CapabilityManifest => ({
  approvals: "none",
  tools: true,
  memory: false,
  artifacts: false,
  subagents: config.subagent !== undefined,
  automation: false,
  shellSnapshot: false,
  transport: "inproc",
})

const promptTextFromMessages = (messages: readonly Message[]): string => {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    if (text !== "") return text
  }
  return ""
}

const createBenchSessionHost = (config: AgentConfig): SessionHost => {
  const wiredConfig = wireOptionalAgentPorts(config, process.env)
  const sessionId = `bench-${crypto.randomUUID()}`
  // ADR-0334 — bench passes EMPTY deps so the install is a no-op
  // (byte-identical replay). The call site is recorded so a future
  // bench-determinism audit can opt deps in via a single edit.
  installCodexR2Wires(wiredConfig, {})
  return {
    describe: () => ({
      sessionId,
      permissionMode: wiredConfig.permission.mode,
      capabilityManifest: capabilityManifestForConfig(wiredConfig),
      identityMode: "default",
      toolProfile: "write",
    }),
    runTurn: async ({ signal }) => {
      const result = await runAgent({
        ...wiredConfig,
        ...(signal !== undefined ? { signal } : {}),
      })
      return { outcome: result, messages: result.messages }
    },
    close: async () => undefined,
  }
}

const captureBenchSessionEvents = (
  listenerPort: Pick<RuntimeSession, "subscribe">,
): {
  readonly events: SessionEvent[]
  readonly unsubscribe: () => void
} => {
  const events: SessionEvent[] = []
  const unsubscribe = listenerPort.subscribe((event) => {
    events.push(event)
  })
  return { events, unsubscribe }
}

const lastTerminalTurnEventOf = (
  events: readonly SessionEvent[],
): Extract<SessionEvent, { type: "turn.completed" | "turn.failed" }> | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === "turn.completed" || event?.type === "turn.failed") return event
  }
  return undefined
}

const runAgentViaSdk = async (
  config: AgentConfig,
  runtimeFactory: typeof createRuntime = createRuntime,
): Promise<AgentOutcome> => {
  const hostSession = createBenchSessionHost(config)
  const runtimeOptions = {
    host: createSingleSessionRuntimeHost(() => hostSession),
  } satisfies Parameters<typeof createRuntime>[0]
  const runtime =
    runtimeFactory === createRuntime
      ? await createRuntime(runtimeOptions)
      : await runtimeFactory(runtimeOptions)
  let session: Awaited<ReturnType<typeof runtime.createSession>> | undefined
  let unsubscribe: (() => void) | undefined
  try {
    const model = (config.llm as { model?: string }).model
    session = await runtime.createSession({
      cwd: config.cwd,
      ...(model !== undefined ? { model } : {}),
      permissionMode: config.permission.mode,
      identityMode: "default",
      toolProfile: "write",
    })
    const eventCapture = captureBenchSessionEvents(session)
    unsubscribe = eventCapture.unsubscribe
    await session.input.append(promptTextFromMessages(config.messages), undefined, {
      signal: config.signal,
    })
    const turn = await session.turn.run(undefined, { signal: config.signal })
    const outcome = turn.turn?.outcome
    if (outcome === undefined) {
      // The session ended without a turn outcome — almost always a deadline/cancel
      // abort MID-turn (e.g. #10097: SIGTERM during an LLM continuation at turn 50).
      // The agent has usually already edited the sandbox, so throwing here would
      // discard a real partial patch and surface as `harness_error:empty_patch`.
      // Instead synthesize a minimal `aborted` outcome: the caller's
      // `withGitSnapshot` still captures the sandbox diff as the candidate patch,
      // and the result is an honest `aborted` (not a misleading hard error).
      const turns = eventCapture.events.filter(
        (e) => e.type === "turn.completed" || e.type === "turn.failed",
      ).length
      return { reason: "aborted", turns, messages: [] }
    }
    const terminalEvent = lastTerminalTurnEventOf(eventCapture.events)
    if (terminalEvent === undefined) {
      throw new Error("bench SDK session completed without a terminal session event")
    }
    if (terminalEvent.type === "turn.completed" && terminalEvent.outcomeReason !== outcome.reason) {
      throw new Error("bench SDK outcome/session event mismatch")
    }
    return outcome
  } finally {
    unsubscribe?.()
    await session?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
}

interface Phase {
  patch: string
  turns: number
  stopReason?: AgentOutcome["reason"]
  agentError?: string
  /** T-202/F6 stream-tap signals (single-pass path only). */
  firstEditFile?: string
  editCount?: number
  turnsToFirstEdit?: number
  /** T-601 — did a repair round clear the (primary-rail) validator? Repair path
   *  only; undefined on single-pass. Derives `primaryRailRedAfterRepair`. */
  validated?: boolean
  /** T-3 OBSERVE-ONLY — clearing round went green on exit code while its typed
   *  rail predicate was evaluable AND mismatched (the false green a
   *  predicate-aware gate would catch). Repair path only. */
  primaryFalseGreen?: boolean
  /** jun-18 RCA OBSERVE-ONLY — a repair round's rail (exit-code) rejected a patch
   *  the repro sentinel reports resolved (false-RED ⇒ wasteful churn). Repair only. */
  primaryFalseRed?: boolean
  verifyRounds?: number
  /** jun-20 — repro-oracle gold calibration for this verify-select run (eval-only
   *  telemetry). Set by the selection phase; undefined on single-pass/repair. */
  reproOracleCalibration?: ReproOracleCalibration
  /** jun-20 — verify-select winner/candidate telemetry (eval-only). Lets a run
   *  self-diagnose which fix sites were spanned, which candidates were
   *  admissible, and why the winner won without re-parsing trajectories. */
  selectionTelemetry?: SelectionTelemetry
  /** OPC-07 — stage packets actually used during this phase. */
  llmEvidence?: LlmEvidenceArtifacts
}

// Bench stream tap is the SSOT in `@/runner/batch/eval/stream-tap` — imported
// above. This prod wrapper and the runner core share the one definition
// (they previously each carried a drifting private copy).

const runAgentOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  seedMsg: string | undefined,
  timeoutMs: number,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(w.stream, undefined, benchVerifyAuthorityCommandsOf(instance))
  // Knob telemetry: emit ONE `knobs_applied` event per runAgent invocation —
  // the greppable per-run marker of which knobs/preset actually ran. The runner
  // driver emits it at both agent entry points; this prod (SDK) wrapper must
  // match or every real trajectory is silently missing the line (split-brain).
  emitKnobsApplied(tap, process.env, stateOverride)
  const outcome = await runAgentViaSdk(
    buildRunnerConfig(
      instance,
      deps,
      sandbox,
      signal,
      tap,
      seedMsg,
      precomputedHint,
      reproHint,
      closureHint,
      postureOverride,
      stateOverride,
    ),
    deps.runtimeFactory,
  )
  const patch = await gitStageAndDiffCached(sandbox, timeoutMs)
  return {
    patch,
    turns: outcome.turns,
    ...(tap.lastVerifyCmd !== undefined ? { lastVerifyCmd: tap.lastVerifyCmd } : {}),
  }
}

const runAgentPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
): Promise<Phase> => {
  let turns = 0
  let stopReason: AgentOutcome["reason"] | undefined
  let agentError: string | undefined
  let firstEditFile: string | undefined
  let editCount: number | undefined
  let turnsToFirstEdit: number | undefined
  // P0 — tentative-patch retention (Sonar absorption). When ON, snapshot the
  // sandbox diff each time the agent's OWN verification passes; on a bad ending
  // (max_turns / aborted — `stopReason !== "completed"`) emit the last
  // verified-green snapshot instead of the empty/regressed final tree. Snapshots
  // run on a serialized best-effort chain (never throw past the run). OFF (or
  // non-swebench) ⇒ no `onVerifyPass` wired ⇒ tap + patch byte-identical.
  // DEFAULT-ON (2026-06-20): pure safety-net — A/B on the 5 max_turns-prone set
  // showed ON==OFF (2/5 each, identical instances) ⇒ regression==0, and the
  // mechanism is proven to fire correctly in a real run (pylint-4604 recovered a
  // verified 444B candidate over a 640B max_turns final). Per the safety-net
  // rule it ships ON the moment regression==0 is confirmed. Off-switch
  // `QUANTA_BENCH_TENTATIVE=0`. Single-pass path only (repair-path is a follow-up).
  const tentativeOn =
    instance.swebench !== undefined && !gateDisabled(process.env, "QUANTA_BENCH_TENTATIVE")
  const recorder = createTentativeRecorder()
  let snapChain: Promise<void> = Promise.resolve()
  const onVerifyPass = tentativeOn
    ? (seq: number): void => {
        snapChain = snapChain.then(async () => {
          try {
            recorder.record(await gitStageAndDiffCached(sandbox, deps.timeoutMs), true, seq)
          } catch {
            /* best-effort: a failed mid-run snapshot must never break the run */
          }
        })
      }
    : undefined
  const rawPatch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const tap = new BenchStreamTap(
        w.stream,
        onVerifyPass,
        benchVerifyAuthorityCommandsOf(instance),
      )
      // Knob telemetry: emit once per phase entry (matches the contract on
      // `emitKnobsApplied`). The single-pass path bypasses `runAgentOnce`, so
      // the emit lives here directly — mirrors the runner driver's runAgentPhase.
      emitKnobsApplied(tap, process.env, stateOverride)
      const outcome = await runAgentViaSdk(
        buildRunnerConfig(
          instance,
          deps,
          sandbox,
          signal,
          tap,
          undefined,
          precomputedHint,
          reproHint,
          closureHint,
          postureOverride,
          stateOverride,
        ),
        deps.runtimeFactory,
      )
      turns = outcome.turns
      stopReason = outcome.reason
      agentError = tap.lastErrorMessage
      firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
      editCount = tap.editCount
      turnsToFirstEdit = tap.turnsToFirstEdit
    },
  )
  // Drain any in-flight snapshots, then select what to emit. `finalOk` = the
  // agent declared done cleanly; any other reason is the "ran out mid-validate"
  // case the retention targets.
  await snapChain
  const patch = tentativeOn
    ? recorder.selectEmitted(rawPatch, stopReason === "completed")
    : rawPatch
  if (tentativeOn && patch !== rawPatch) {
    // P0 telemetry — log ONLY when retention actually substitutes (the rare,
    // interesting case): the run ended badly and we recovered a verified-green
    // intermediate over the empty/regressed final tree.
    logger.warn(
      `[tentative] ${instance.id}: ENGAGED — emitted verified candidate ` +
        `(${recorder.count} recorded, stopReason=${stopReason}) ` +
        `${patch.length}B over ${rawPatch.length}B final`,
    )
  }
  return {
    patch,
    turns,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(agentError !== undefined ? { agentError } : {}),
    ...(firstEditFile !== undefined ? { firstEditFile } : {}),
    ...(editCount !== undefined ? { editCount } : {}),
    ...(turnsToFirstEdit !== undefined ? { turnsToFirstEdit } : {}),
  }
}

const runRepairPhase = async (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
  w: Wiring,
  repair: NonNullable<RunInstanceDeps["repair"]>,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  primaryRailStep: PrimaryRailStep | undefined,
  siblingOwners: readonly string[],
  reproSources: readonly string[],
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
  let repairValidated = false
  let repairFalseGreen = false
  let repairFalseRed = false
  let repairRounds = 0
  const repairLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  // #2 repro-vote: K-of-N RESOLVED majority gate when the knob is on AND a
  // reproducing set exists; else byte-identical `repair.validate ?? defaultValidate`.
  const validate = buildReproVoteValidate(
    instance,
    reproSources,
    repair.validate ?? defaultValidate,
  )
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const out = await runRepairRounds({
        config: { ...(repair.maxRounds !== undefined ? { maxRounds: repair.maxRounds } : {}) },
        problem: instance.problemStatement,
        runOnce: (seedMsg) =>
          runAgentOnce(
            instance,
            deps,
            sandbox,
            signal,
            w,
            seedMsg,
            deps.timeoutMs,
            precomputedHint,
            reproHint,
            closureHint,
            postureOverride,
            stateOverride,
          ),
        validate,
        buildContext: (ctxArgs) => {
          const repairArgs = { ...ctxArgs, siblingOwners }
          const repairSeed = buildRepairRoundSeedMessage(
            repairArgs,
            repair.buildContext?.(repairArgs),
          )
          recordLlmEvidencePacket(repairLlmEvidence, repairSeed.packet)
          return repairSeed.seedMsg
        },
        sandbox,
        exec,
        timeoutMs: deps.timeoutMs,
        evaluatePredicate: evaluateSuccessPredicate,
        ...(primaryRailStep !== undefined ? { primaryRailStep } : {}),
      })
      turns = out.turns
      finalPatch = out.patch
      repairValidated = out.validated
      repairFalseGreen = out.primaryFalseGreen
      repairFalseRed = out.primaryFalseRed
      repairRounds = out.rounds
    },
  )
  return {
    patch: patch !== "" ? patch : finalPatch,
    turns,
    validated: repairValidated,
    primaryFalseGreen: repairFalseGreen,
    primaryFalseRed: repairFalseRed,
    ...(repairRounds > 0 ? { verifyRounds: repairRounds } : {}),
    ...(Object.keys(repairLlmEvidence).length > 0 ? { llmEvidence: repairLlmEvidence } : {}),
  }
}

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

const unavailableReproCalibration = (): ReproOracleCalibration => ({
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
})

const resolveSelectionReproConsensus = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
  reproSources: readonly string[],
  mode: BenchPosture["verifySelectRepro"],
) => {
  const reproPolicy = selectionReproPolicy(mode)
  const calibrationUnavailable = unavailableReproCalibration()
  if (!reproPolicy.enabled) {
    return {
      reproPolicy,
      resolvedKofNSelectionPort: undefined,
      reproConsensusProofSelectionPort: undefined,
      calibration: calibrationUnavailable,
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
  readonly postureOverride?: BenchPosture
  readonly stateOverride?: BenchKnobState
  readonly concurrency: number | undefined
  readonly baseValidatedRed: boolean | null
  readonly generationErrors: Map<number, string>
  readonly addTurns: (turns: number) => void
}): Promise<Candidate> => {
  const isolated = args.concurrency !== undefined && args.concurrency > 1
  const candidateSandbox = isolated
    ? await forkSandbox(args.instance.id, args.sandbox)
    : args.sandbox
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
    )
    args.addTurns(phase.turns)
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
      ...(phase.stopReason !== undefined ? { stopReason: phase.stopReason } : {}),
      ...(phase.agentError !== undefined ? { agentError: phase.agentError } : {}),
      ...(phase.editCount !== undefined ? { editCount: phase.editCount } : {}),
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

/** Map a public-contract bundle into typed, provenance-carrying contract facts. */
const contractFactsFromBundle = (
  contracts: PublicContractBundle | undefined,
): readonly ContractFact[] =>
  contracts?.contracts.map((c) => ({
    contractId: c.contractId,
    authority: `${c.provenance}/${c.strength}`,
    satisfied: "unknown" as const,
  })) ?? []

/**
 * TD — verify-and-select phase. Generates N closure-diversity-seeded candidates
 * (candidate 0 = unbiased; candidate i>0 nudged toward the i-th ranked owner so
 * the set spans different FIX SITES) and submits the {@link runSelection} pick.
 * Each candidate is a full agent run on a fresh snapshot (`withGitSnapshot`
 * resets the tree between them). Reached ONLY when the `verify-select` knob set
 * `verifySelectN`; otherwise the single-pass path runs (byte-identical).
 */
const runSelectionPhase = async (
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
  publicContracts: PublicContractBundle | undefined,
  verifySelectRegression: BenchPosture["verifySelectRegression"],
  regressionMaxTests: number | undefined,
  verifySelectRepro: BenchPosture["verifySelectRepro"],
  selectionOwnerCandidates: readonly string[],
  ownerResolved: PreparedAttemptContext["ownerResolved"],
  baseValidatedRed: boolean,
  verificationPlan: PreparedAttemptContext["verificationPlan"],
  reproTest: BenchReproTestTelemetry | undefined,
  precomputedHint: string | undefined,
  reproHint: string | undefined,
  closureHint: string | undefined,
  reproSources: readonly string[],
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
): Promise<Phase> => {
  // SCAFF-04/05 parity (see runner driver): AST witnesses feed BOTH generation
  // families (complete candidate is generated) and required contracts (it wins).
  const staticWitnesses = buildAstStaticWitnesses({
    problemStatement: instance.problemStatement,
    ownerCandidates: selectionOwnerCandidates,
    ...(ownerResolved !== undefined ? { ownerResolved } : {}),
    readSource: (rel) => readSandboxSource(sandbox, rel),
  })
  const candidateFamilyBundle = withStaticWitnessFamilies(
    buildSelectionCandidateFamilyBundle({
      problemStatement: instance.problemStatement,
      ownerCandidates: selectionOwnerCandidates,
      ownerResolved,
      readSource: (rel) => readSandboxSource(sandbox, rel),
    }),
    staticWitnesses,
  )
  const familyPublicContracts = withCandidateFamilyPublicContracts(
    publicContracts,
    candidateFamilyBundle,
  )
  const staticWitnessContracts = buildStaticWitnessContracts(staticWitnesses)
  const effectivePublicContracts: PublicContractBundle | undefined =
    staticWitnessContracts.length === 0
      ? familyPublicContracts
      : {
          contracts: [
            ...new Map(
              [...(familyPublicContracts?.contracts ?? []), ...staticWitnessContracts].map((c) => [
                c.contractId,
                c,
              ]),
            ).values(),
          ],
        }
  const selectionInputs = buildSelectionInputs({
    n,
    ownerCandidates: selectionOwnerCandidates,
    sandbox,
    ...(candidateFamilyBundle !== undefined ? { candidateFamilies: candidateFamilyBundle } : {}),
  })
  const oracleFailureRepairSeed = validatedReproRepairSeed(reproSources)
  const generationErrors = new Map<number, string>()
  const selectionLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  const verificationTarget = verificationTargetFromPlan(verificationPlan)
  const selectionOwnerEvidence = buildSelectionOwnerEvidence({
    ownerFiles: selectionInputs.ownerFiles,
    issueSymbols: extractIssueHint(instance.problemStatement).symbols,
    staticWitnesses,
    readSource: (rel) => readSandboxSource(sandbox, rel),
  })
  const selectionBaseValidatedRed =
    verifySelectRegression === "discovered" ? null : baseValidatedRed
  const generationEnvCaveats = selectionGenerationEnvCaveats({
    reproHint,
    reproTest,
  })
  const mergeHint = (seed: string | undefined): string | undefined =>
    verifySelectProofRequired && selectorMode === "clean"
      ? buildSelectionGenerationPrompt({
          problemStatement: instance.problemStatement,
          ownerEvidence: selectionOwnerEvidence,
          contracts: contractFactsFromBundle(effectivePublicContracts),
          baseValidatedRed: selectionBaseValidatedRed,
          ...(verificationTarget !== undefined ? { verificationTarget } : {}),
          ...(reproHint !== undefined ? { reproCommand: reproHint } : {}),
          ...(reproSources.length > 0 ? { validatedReproScripts: reproSources } : {}),
          ...(closureHint !== undefined ? { closureHint } : {}),
          ...(generationEnvCaveats.length > 0 ? { envCaveats: generationEnvCaveats } : {}),
          // NOTE: the validated repro scripts reach generation ONCE, via
          // `validatedReproScripts` → `validated_public_repro` staticFacts (full,
          // bounded). They are deliberately NOT also merged into `seed`: that
          // prepend pushed the real diversity/counterfactual seed past the seed's
          // length cap (destroying fix-site diversity) and duplicated the scripts.
          ...(seed !== undefined ? { seed } : {}),
          recordLlmEvidencePacket: (packet) => {
            recordLlmEvidencePacket(selectionLlmEvidence, packet)
          },
        })
      : seed === undefined
        ? closureHint
        : closureHint === undefined
          ? seed
          : `${closureHint}\n\n${seed}`

  let totalTurns = 0
  // jun-20 — GOLD-CALIBRATE the resolved-consensus oracle BEFORE generation (it
  // resets the sandbox to base). A confirmed false-negative oracle ⇒ the
  // resolvedKofN port fails open (never rejects a candidate); the calibration is
  // surfaced as eval-only telemetry so the campaign self-measures the oracle's
  // false-negative rate (the verify-and-select bottleneck).
  const { reproPolicy, resolvedKofNSelectionPort, reproConsensusProofSelectionPort, calibration } =
    await resolveSelectionReproConsensus(
      instance,
      sandbox,
      deps.timeoutMs,
      reproSources,
      verifySelectRepro,
    )
  const discoveredRegressionPort =
    verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionPort({ instance, sandbox, timeoutMs: deps.timeoutMs })
      : undefined
  const publicRegressionProofSelectionPort =
    verifySelectRegression === "discovered"
      ? makeDiscoveredRepoRegressionProofPort({ instance, sandbox, timeoutMs: deps.timeoutMs })
      : undefined
  const regressionSelectionPort = makeSelectionRegressionPort({
    verifySelectRegression,
    discoveredRegressionPort,
    instance,
    sandbox,
    timeoutMs: deps.timeoutMs,
  })
  const staticSanitySelectionPort = makeSelectionStaticSanityPort({
    sandbox,
    baseCommit: instance.swebench?.baseCommit,
    timeoutMs: deps.timeoutMs,
  })
  const smokeSelectionPort = await prepareIssueSmokeSelectionPort(instance, sandbox, deps.timeoutMs)
  const mweProofSelectionPort =
    selectorMode === "clean"
      ? await prepareMweProofSelectionPort(instance, sandbox, deps.timeoutMs)
      : undefined
  // No-oracle verify-select (`discovered`) must not let synthesized repro
  // authority veto admissibility. In that mode, impacted repo tests are the hard
  // regression signal and repro consensus is already downgraded to positive-only
  // soft credit / fail-open; keep repro-authority absent as `null`, not `false`.
  const selectionRiskGate = buildSelectionRiskGate({
    structural: riskGate,
    llmMode: llmRiskGateMode,
    llm: deps.llm,
    problemStatement: instance.problemStatement,
    ownerFiles: selectionOwnerCandidates,
    ownerEvidence: selectionOwnerEvidence,
    ...(instance.swebench?.repo !== undefined ? { repo: instance.swebench.repo } : {}),
    signal,
  })
  const result = await runSelection({
    n,
    problemStatement: instance.problemStatement,
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    owners: selectionInputs.owners,
    seeds: selectionInputs.seeds,
    candidateFamilies: selectionInputs.candidateFamilies,
    resolvedKofNMode: reproPolicy.resolvedKofNMode,
    earlyAccept,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(selectionRiskGate !== undefined ? { riskGate: selectionRiskGate } : {}),
    ...(counterfactual ? { counterfactual: true } : {}),
    mode: selectorMode,
    ...(verifySelectProofRequired ? { proofRequired: true } : {}),
    ...(effectivePublicContracts !== undefined
      ? { publicContracts: effectivePublicContracts }
      : {}),
    ...(oracleFailureRepairSeed !== undefined ? { oracleFailureRepairSeed } : {}),
    recordLlmEvidencePacket: (packet: LlmEvidencePacket) => {
      recordLlmEvidencePacket(selectionLlmEvidence, packet)
    },
    ports: {
      generate: (i, seed) =>
        generateSelectionCandidate({
          index: i,
          seed,
          instance,
          deps,
          sandbox,
          signal,
          wiring: w,
          precomputedHint,
          reproHint,
          postureOverride,
          stateOverride,
          mergeHint,
          concurrency,
          baseValidatedRed: selectionBaseValidatedRed,
          generationErrors,
          addTurns: (turns) => {
            totalTurns += turns
          },
        }),
      applyClean: (c) =>
        candidatePatchAppliesCleanly({
          sandbox,
          patch: c.patch,
          baseCommit: instance.swebench?.baseCommit,
          timeoutMs: deps.timeoutMs,
        }),
      staticSanity: staticSanitySelectionPort,
      regression: regressionSelectionPort,
      ...(publicRegressionProofSelectionPort !== undefined
        ? { publicRegressionProof: publicRegressionProofSelectionPort }
        : {}),
      ...(smokeSelectionPort !== undefined ? { smoke: smokeSelectionPort } : {}),
      ...(mweProofSelectionPort !== undefined ? { mweProof: mweProofSelectionPort } : {}),
      // SOTA++ repro-vote as the SELECTION scorer: re-materialize each candidate
      // and re-run the reproducing repro set there → the VerificationBundle's
      // `patchedResolvedKofN` HARD signal (votes<k ⇒ reject). So selection picks
      // the candidate the repro set reports RESOLVED. Empty reproducing set ⇒ a
      // port that yields null (no objection). Gold-calibrated above — a confirmed
      // false-negative oracle is failed open so it never rejects a correct fix.
      ...(resolvedKofNSelectionPort !== undefined
        ? { resolvedKofN: resolvedKofNSelectionPort }
        : {}),
      ...(reproConsensusProofSelectionPort !== undefined
        ? { reproConsensusProof: reproConsensusProofSelectionPort }
        : {}),
      ...(selectorMode === "clean"
        ? {
            deriveCandidateStructuralRepair: (candidate: Candidate) =>
              deriveCandidateStructuralRepair({
                instance,
                candidate,
                sandbox,
                signal,
              }),
          }
        : {}),
    },
  })
  if (result.successfulGenerations === 0 && result.generationFailures > 0) {
    const orderedErrors = [...generationErrors.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, error]) => error)
    const sample = orderedErrors.slice(0, 2).join("; ")
    return {
      patch: "",
      turns: totalTurns,
      stopReason: "error",
      agentError:
        "agent stopped with error before verification: " +
        `verify-select candidate generation failed for all ${n} candidates` +
        (sample === "" ? "" : ` (${sample})`),
      reproOracleCalibration: calibration,
      selectionTelemetry: summarizeSelection(result),
      ...(Object.keys(selectionLlmEvidence).length > 0 ? { llmEvidence: selectionLlmEvidence } : {}),
    }
  }
  return {
    patch: result.winner?.patch ?? "",
    turns: totalTurns,
    ...(result.terminalCandidate?.stopReason !== undefined
      ? { stopReason: result.terminalCandidate.stopReason }
      : {}),
    ...(result.terminalCandidate?.agentError !== undefined
      ? { agentError: result.terminalCandidate.agentError }
      : {}),
    ...(result.terminalCandidate?.editCount !== undefined
      ? { editCount: result.terminalCandidate.editCount }
      : {}),
    reproOracleCalibration: calibration,
    selectionTelemetry: summarizeSelection(result),
    ...(Object.keys(selectionLlmEvidence).length > 0 ? { llmEvidence: selectionLlmEvidence } : {}),
  }
}

const runAppMainPhase = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
}): Promise<Phase> => {
  if (args.prepared.posture.verifySelectN !== undefined && args.instance.swebench !== undefined) {
    const publicContracts = buildCleanSelectionPublicContracts({
      declaredExpected: args.prepared.closureSession?.issueDeclaredExpected,
      candidates: args.prepared.closureSession?.bundle.evidence.candidates,
      apiSymbols: args.prepared.closureSession?.bundle.evidence.issueSymbols,
    })
    return runSelectionPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.posture.verifySelectN,
      args.prepared.posture.verifySelectConcurrency,
      args.prepared.posture.verifySelectEarlyAccept,
      args.prepared.posture.verifySelectRiskGate,
      args.prepared.posture.verifySelectLlmRiskGate,
      args.prepared.posture.verifySelectCounterfactual,
      args.prepared.posture.selectorMode,
      args.prepared.posture.verifySelectProofRequired,
      publicContracts,
      args.prepared.posture.verifySelectRegression,
      args.prepared.posture.regressionMaxTests,
      args.prepared.posture.verifySelectRepro,
      args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      args.prepared.ownerResolved,
      args.prepared.verificationPlan?.baseValidatedRed ?? false,
      args.prepared.verificationPlan,
      args.prepared.reproTest,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
      args.prepared.posture,
      args.prepared.state,
    )
  }
  if (args.prepared.runRepair && args.prepared.effectiveRepair !== undefined) {
    return runRepairPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.effectiveRepair,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.primaryRailStep,
      args.prepared.ownerResolved?.map((o) => o.file) ?? [],
      args.prepared.reproSources,
      args.prepared.posture,
      args.prepared.state,
    )
  }
  return runAgentPhase(
    args.instance,
    args.deps,
    args.sandbox,
    args.signal,
    args.wiring,
    args.prepared.precomputedHint,
    args.prepared.reproHint,
    args.prepared.closureHint,
    args.prepared.posture,
    args.prepared.state,
  )
}

const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  // The per-instance wall-clock deadline bounds the AGENT SOLVE only — NOT env
  // setup (copyRepo + setupCmd + hint/repro install), which have their own
  // timeouts (runEnvPrep). Starting the timer here (pre-setup) let cold-start
  // overhead eat the agent's think budget and abort it mid-solve under
  // concurrency (observed: 68% spurious aborts). The timer is armed below, once
  // setup is done, so the agent always gets the full `timeoutMs`.
  let deadline: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  let reproTest: BenchReproTestTelemetry | undefined
  let prepared: PreparedAttemptContext | undefined
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) return envPrepFailedResult(instance, prep)

    prepared = await prepareAttemptContext(instance, sandbox, deps, abort.signal)
    const preparedContext = prepared
    reproTest = preparedContext.reproTest

    // Setup is done — arm the solve deadline now so the agent gets the full
    // `timeoutMs` of think time (see note where `deadline` is declared).
    deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
    if (v5AdaptiveEnabled({ preset: preparedContext.state.preset, envVars: process.env })) {
      const thinPhase = await runAppMainPhase({
        instance,
        deps,
        sandbox,
        signal: abort.signal,
        wiring: w,
        prepared: preparedContext,
      })
      let finalPrepared = preparedContext
      let finalPhase = thinPhase
      const revisions: string[] = []
      const initialPacket = buildAdaptivePhasePacket({
        instance,
        phase: thinPhase,
        prepared: preparedContext,
        sandbox,
      })
      revisions.push(initialPacket.evidenceRevision)
      const adaptive = await runAdaptiveBenchAttempt({
        intakePacket: initialPacket,
        base: preparedContext.state,
        env: process.env,
        modelCall: makeAdaptiveToolModelCall({ llm: deps.llm, signal: abort.signal }),
        runPhase: async ({ state, posture }) => {
          const nextPrepared = await prepareAttemptContext(
            instance,
            sandbox,
            deps,
            abort.signal,
            posture,
            state,
          )
          const nextPhase = await runAppMainPhase({
            instance,
            deps,
            sandbox,
            signal: abort.signal,
            wiring: w,
            prepared: nextPrepared,
          })
          finalPrepared = nextPrepared
          finalPhase = nextPhase
          const packet = buildAdaptivePhasePacket({
            instance,
            phase: nextPhase,
            prepared: nextPrepared,
            sandbox,
          })
          revisions.push(packet.evidenceRevision)
          return { packet }
        },
      })
      const adaptiveRoute = {
        outcome: adaptive.outcome,
        steps: adaptive.steps,
        evidenceRevisions: revisions,
        ...(adaptive.reason !== undefined ? { reason: String(adaptive.reason) } : {}),
        ...(adaptive.finalDecision !== undefined
          ? {
              finalAction: adaptive.finalDecision.action,
              finalWhy: adaptive.finalDecision.why,
              citedEvidenceIds: adaptive.finalDecision.citedEvidenceIds,
            }
          : {}),
      } satisfies NonNullable<InstanceResult["adaptiveRoute"]>
      if (adaptive.outcome !== "finalize") {
        return {
          ...latePhaseFailureResultOf({
            instance,
            phase: finalPhase,
            reproTest,
            error: `adaptive controller stopped: ${String(adaptive.reason ?? adaptive.outcome)}`,
            prepared: finalPrepared,
            sandbox,
          }),
          adaptiveRoute,
        }
      }
      phase = finalPhase
      prepared = finalPrepared
      const terminal = await maybeValidateTerminalResult({
        instance,
        phase: finalPhase,
        reproTest,
        deps,
        wiring: w,
        startedAt,
        signal: abort.signal,
        prepared: finalPrepared,
        sandbox,
      })
      if (terminal !== undefined) return { ...terminal, adaptiveRoute }
      return {
        ...(await verifyAndFinalizeResult({
          instance,
          phase: finalPhase,
          deps,
          sandbox,
          signal: abort.signal,
          reproTest,
          wiring: w,
          startedAt,
          prepared: finalPrepared,
        })),
        adaptiveRoute,
      }
    }

    phase = await runAppMainPhase({
      instance,
      deps,
      sandbox,
      signal: abort.signal,
      wiring: w,
      prepared: preparedContext,
    })

    const terminal = await maybeValidateTerminalResult({
      instance,
      phase,
      reproTest,
      deps,
      wiring: w,
      startedAt,
      signal: abort.signal,
      prepared: preparedContext,
      sandbox,
    })
    if (terminal !== undefined) return terminal

    // Await inside the try so sandbox cleanup in `finally` cannot race the
    // final verifier. A bare `return promise` here would run `finally`
    // immediately and tear down the sandbox while verify is still spawning.
    return await verifyAndFinalizeResult({
      instance,
      phase,
      deps,
      sandbox,
      signal: abort.signal,
      reproTest,
      wiring: w,
      startedAt,
      prepared: preparedContext,
    })
  } catch (error) {
    if (error instanceof ObservationError) {
      return latePhaseFailureResultOf({
        instance,
        phase,
        reproTest,
        verdict: "degraded",
        error: `observation failed (strict): ${error.message}`,
        ...(prepared !== undefined ? { prepared, sandbox } : {}),
      })
    }
    if (error instanceof StrictLspGroundingDegradedError) {
      return latePhaseFailureResultOf({
        instance,
        phase,
        reproTest,
        verdict: "degraded",
        error: error.message,
        ...(prepared !== undefined ? { prepared, sandbox } : {}),
      })
    }
    if (error instanceof PacketBlindnessViolation) {
      // A blindness-guard throw means an evidence packet was built from a
      // forbidden source — a CONSTRUCTION bug, not a candidate miss. Classify
      // `degraded` (excluded from resolved/total) so it can never silently
      // confound a measurement run as a real failure.
      return latePhaseFailureResultOf({
        instance,
        phase,
        reproTest,
        verdict: "degraded",
        error: `evidence packet blindness violation (build aborted): ${error.message}`,
        ...(prepared !== undefined ? { prepared, sandbox } : {}),
      })
    }
    return latePhaseFailureResultOf({
      instance,
      phase,
      reproTest,
      error: errMessage(error),
      ...(prepared !== undefined ? { prepared, sandbox } : {}),
    })
  } finally {
    clearTimeout(deadline)
    w.observer?.close()
    await cleanupSandbox(sandbox)
  }
}

/**
 * Public entry-point with the transient-retry wrapper (measurement-stability).
 *
 * `maxAttempts` precedence: `deps.measurementStability?.maxAttempts` (test seam)
 * > unified posture `retryTransient` (preset/env via the knob framework — preset
 * `agentless-v1` ⇒ 3; explicit `QUANTA_BENCH_RETRY_TRANSIENT` overrides) > 1.
 *
 * Byte-identical fence: when `maxAttempts === 1` (default, no preset/env) the
 * wrapper calls `runInstanceOnce` EXACTLY ONCE and returns its result verbatim
 * (no `budget` stamp) — identical to the pre-wrapper single-pass shape and
 * wall-clock. Only the multi-attempt path stamps `budget`.
 *
 * Unlike the (dead) runner-driver wrapper this DELIBERATELY does NOT scale the
 * per-attempt timeout by knob `costMultiplier`: those multipliers are a
 * matrix-budget construct (e.g. repro-test=40) and using them as a wall-clock
 * multiplier balloons an `agentless-v1` instance ~15× unexpectedly. Per-attempt
 * timeout stays operator-controlled (`--timeout` / `QUANTA_BENCH_TIMEOUT_MS`).
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const maxAttempts = Math.max(
    1,
    Math.floor(deps.measurementStability?.maxAttempts ?? benchOptIns().retryTransient ?? 1),
  )
  if (maxAttempts === 1) return runInstanceOnce(instance, deps)

  const policy = deps.measurementStability?.policy ?? DEFAULT_POLICY
  const { result, loop } = await runRetryLoop(
    async () => runInstanceOnce(instance, deps),
    maxAttempts,
    policy,
  )
  return {
    ...result,
    budget: {
      baseTimeoutMs: deps.timeoutMs,
      // `adaptedTimeoutMs === baseTimeoutMs` BY DESIGN here: this prod path
      // deliberately skips the knob-`costMultiplier` wall-clock scaling the
      // (dead) runner-driver twin applies (see the runInstance doc above). So
      // this is the timeout actually used per attempt — truthful, not a no-op
      // copy. Do NOT "fix" it to compute a scaled value without re-reading why.
      adaptedTimeoutMs: deps.timeoutMs,
      attempts: loop.attempts,
      attemptOutcomes: loop.outcomes.map(projectOutcome),
    },
  }
}

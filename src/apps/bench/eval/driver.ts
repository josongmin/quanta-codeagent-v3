import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type AgentConfig, type AgentOutcome, runAgent, wireOptionalAgentPorts } from "@/agent"
import { evaluateSuccessPredicate, type PrimaryRailStep } from "@/agent/closure"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { extractIssueHint } from "@/agent/issue-hint"
import { extractIssueDeclaredExpected, type IssueDeclaredExpected } from "@/agent/verification-plan"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import type { LLMPort, Message } from "@/llm"
import type { CapabilityManifest, SessionEvent } from "@/protocol/session"
import {
  resolveEffortLadderLimits,
  runAdaptiveBenchAttempt,
} from "@/runner/batch/eval/adaptive-escalation"
import { buildAdaptiveRouterModelCall } from "@/runner/batch/eval/adaptive-escalation/live-model-call"
import {
  classifyDoneTimeCapture,
  type DoneTimeCaptureClass,
  isCaptureFailure,
} from "@/runner/batch/eval/capture-correctness"
import {
  buildPublicDeclaredExpectedPort,
  resolveRepairEvaluatePredicate,
} from "@/runner/batch/eval/declared-expected-matcher"
import {
  adaptiveNextPassOwners,
  applyBenchKnobs,
  attachAndPersistReproVoteOutcomes,
  type BenchKnobState,
  BenchObserver,
  type BenchPosture,
  benchBudgetMeterFromEnv,
  benchOptIns,
  benchPostureFromState,
  benchVerifyAuthorityCommandsOf,
  buildAdaptivePhasePacket,
  buildReproVoteValidate,
  buildConfig as buildRunnerConfig,
  composeWithReproHint,
  computeEffectiveProofRequired,
  DEFAULT_POLICY,
  deriveCandidateStructuralRepair,
  emitKnobsApplied,
  enumerateRepoSources,
  envPrepFailedResult,
  familyCoverageCoeditEnabled,
  type IssueHintMode,
  knobsForReport,
  latePhaseFailureResultOf,
  applySampleTemperature,
  makeAcceptanceSelectCandidates,
  maybeReviewSubmission,
  makeCalibratedReproConsensusPort,
  makeReproConsensusProofSelectionPort,
  resolveAcceptanceLlmRerank,
  makeReproConsensusSelectionPort,
  makeSelectionRegressionPort,
  makeSelectionStaticSanityPort,
  maybeRunRepairEscalationFollowup,
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
  repairLocalizePhaseSuppressed,
  reproHintMessage,
  resetReproVoteOutcomes,
  resolveBenchKnobs,
  resolveLaneLlm,
  resolveLocationFanoutSeeder,
  runRetryLoop,
  type RunInstanceDeps as SharedRunInstanceDeps,
  StrictLspGroundingDegradedError,
  selectionReproPrepK,
  UsageTap,
  validatedReproRepairSeed,
  verifyAndFinalizeResult,
} from "@/runner/batch/eval/driver"
import { coeditFamilyCoverageCandidate } from "@/runner/batch/eval/family-coverage-coedit"
import {
  buildRepairFanoutFiles,
  buildRepairFanoutSymbols,
  type PerCandidateSeed,
} from "@/runner/batch/eval/location-set-fanout"
import {
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  PacketBlindnessViolation,
  recordLlmEvidencePacket,
  type SelectionGenerationPromptInput,
  type VerificationTargetFact,
  verificationTargetFromPlan,
} from "@/runner/batch/eval/llm-evidence-packet"
import { prepareMweProofSelectionPort } from "@/runner/batch/eval/mwe-proof-port"
import { installProjectEnvPythonShim } from "@/runner/batch/eval/project-env-python-shim"
import { buildCleanSelectionAuthorityContracts } from "@/runner/batch/eval/public-contract-bundle"
import type { SelectionContractBundle } from "@/runner/batch/eval/public-contract-types"
import {
  applyCandidatePatch,
  candidatePatchAppliesCleanly,
  materializeBuildEnv,
  resetToBase,
} from "@/runner/batch/eval/rematerialize"
import { writeCandidatePool } from "@/runner/batch/eval/repair/candidate-ledger-sink"
import {
  buildRepairRoundsConfig,
  makeRepairBreadthRunCandidates,
} from "@/runner/batch/eval/repair-breadth"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
} from "@/runner/batch/eval/repair-phase-policy"
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
import {
  createSessionScopedSignal,
  withSessionScopedSignal,
} from "@/runner/batch/eval/session-signal"
import { BenchStreamTap, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import { createTentativeRecorder } from "@/runner/batch/eval/tentative-patch"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { errMessage, foldGroundingReceipts, gateDisabled, gateOn, logger } from "@/shared"
import { v5AdaptiveEnabled } from "../preset"
import type {
  BenchReproTestTelemetry,
  Instance,
  InstanceResult,
  ReproOracleCalibration,
} from "../types"
import { runEnvPrep } from "./env-prep"
import { exec } from "./exec"
import { runRepairRounds } from "./repair/index"
import { buildRepairRoundSeedMessage } from "./repair/llm-evidence"
import type { RunOnceResult } from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import { buildWiring, emitSandbox, NullStream, ObservationError, type Wiring } from "./report"
import { cleanupSandbox, copyRepo, createSandbox, forkSandbox } from "./sandbox"
import { gitStageAndDiffCached, gitWorktreeHasStagedChanges, withGitSnapshot } from "./snapshot"

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
  reproHintMessage,
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

const captureLostEditsError = (editCount: number | undefined, sandbox: string): string =>
  `capture_lost_edits: ${editCount ?? 0} edit(s) made but 0-byte source diff on a clean worktree ` +
  `(fork-worktree desync, sandbox=${sandbox})`

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
  const sessionSignal = createSessionScopedSignal(config.signal)
  const scopedConfig = withSessionScopedSignal(config, sessionSignal.signal)
  const hostSession = createBenchSessionHost(scopedConfig)
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
    await session.input.append(promptTextFromMessages(scopedConfig.messages), undefined, {
      signal: scopedConfig.signal,
    })
    const turn = await session.turn.run(undefined, { signal: scopedConfig.signal })
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
    sessionSignal.abort()
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
  /** Successful SOURCE edits (excludes test/scratch edits). Threaded so the
   *  capture-miss guard can distinguish a real source-edit capture desync from a
   *  test-only-edit timeout. See runner driver `patchCaptureMissErrorOf`. */
  sourceAppliedEditCount?: number
  turnsToFirstEdit?: number
  /** T5 — done-time patch-capture class. `lost-edits` ⇒ the agent edited but the
   *  captured tree is empty AND clean (fork-worktree desync, 11138 class): an
   *  infra capture failure to retry, never a silent empty submit. Single-pass. */
  captureClass?: DoneTimeCaptureClass
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
  /** jun-28 A2 — final repair-gate authority decision (observe-only). */
  repairValidationDecision?: import("@/runner/batch/eval/repair/decision").ValidationDecision
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
  /** Structural owner widening actually consumed before this phase ran. */
  ownerWidening?: NonNullable<InstanceResult["ownerWidening"]>
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
  /** repair-loop BREADTH (jun-28): per-candidate provider lane port. Routed by
   *  the breadth fan-out so candidate `i` is generated by lane `i mod laneCount`
   *  when model-lane-diversity + ≥2 lanes are configured. Absent ⇒ `deps.llm`
   *  (byte-identical single-candidate / non-breadth path). */
  laneLlm?: LLMPort,
): Promise<RunOnceResult> => {
  const tap = new BenchStreamTap(
    w.stream,
    undefined,
    benchVerifyAuthorityCommandsOf(instance),
    // Per-action progress → run.log (live "what the agent did" under concurrency).
    // One concise line per tool call. The verify-select phase below already wired
    // this; the single-pass path (the default for most presets) was the gap, so a
    // full-remote run.log showed only coarse "▶ instance" milestones and never the
    // per-turn agent actions — exactly the live LLM-process visibility that was
    // missing.
    (name, detail) => logger.info(`  · ${instance.id} ${name}${detail ? ` ${detail}` : ""}`),
  )
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
      undefined,
      laneLlm,
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

const classifyPhaseCapture = async (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
  readonly rawPatch: string
  readonly sourceAppliedEditCount: number | undefined
  readonly totalEditCount: number | undefined
  readonly firstEditFile: string | undefined
  readonly agentError: string | undefined
}): Promise<{
  readonly captureClass: DoneTimeCaptureClass
  readonly agentError: string | undefined
}> => {
  const facts = classifyDoneTimeCapture({
    sourcePatch: args.rawPatch,
    rawDirty: await gitWorktreeHasStagedChanges(args.sandbox, args.timeoutMs),
    editCount: args.sourceAppliedEditCount ?? 0,
    touchedFiles: filesFromPatch(args.rawPatch),
  })
  const captureClass = facts.captureClass
  if (!isCaptureFailure(captureClass)) {
    return { captureClass, agentError: args.agentError }
  }
  logger.warn(
    `[capture] ${args.instance.id}: LOST-EDITS — ${args.sourceAppliedEditCount ?? 0} successful ` +
      "source edit(s) observed but the done-time source diff is empty and the " +
      "worktree is clean (capture desync or outside-sandbox write). Routed as infra capture " +
      "failure, NOT a model miss.",
  )
  if (gateOn(process.env, "QUANTA_CAPTURE_DEBUG")) {
    const dbgStatus = await exec(
      "git status --porcelain --untracked-files=all",
      args.sandbox,
      args.timeoutMs,
    ).catch(() => null)
    logger.warn(
      `[capture-debug] ${args.instance.id}: sandbox=${args.sandbox} firstEditFile=${args.firstEditFile ?? "?"} ` +
        `sourceBytes=${facts.sourcePatchBytes} appliedEdits=${facts.editCount} rawDirty=${facts.rawDirty} ` +
        `touched=[${facts.touchedFiles.join(",").slice(0, 200)}] ` +
        `status=[${(dbgStatus?.stdout ?? "git-fail").slice(0, 400).replace(/\n/g, "|")}]`,
    )
  }
  return {
    captureClass,
    agentError: args.agentError ?? captureLostEditsError(args.totalEditCount, args.sandbox),
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
  laneLlm?: LLMPort,
): Promise<Phase> => {
  let turns = 0
  let stopReason: AgentOutcome["reason"] | undefined
  let agentError: string | undefined
  let firstEditFile: string | undefined
  let editCount: number | undefined
  let sourceAppliedEditCount: number | undefined
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
        // Per-action progress → run.log (live "what the agent did" under
        // concurrency). One concise line per tool call.
        (name, detail) => logger.info(`  · ${instance.id} ${name}${detail ? ` ${detail}` : ""}`),
      )
      // Knob telemetry: emit once per phase entry (matches the contract on
      // `emitKnobsApplied`). The single-pass path bypasses `runAgentOnce`, so
      // the emit lives here directly — mirrors the runner driver's runAgentPhase.
      emitKnobsApplied(tap, process.env, stateOverride)
      await installProjectEnvPythonShim(instance, sandbox)
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
          undefined,
          laneLlm,
        ),
        deps.runtimeFactory,
      )
      turns = outcome.turns
      stopReason = outcome.reason
      agentError = tap.lastErrorMessage
      firstEditFile = relFromSandbox(sandbox, tap.firstEditFile)
      editCount = tap.editCount
      sourceAppliedEditCount = tap.sourceAppliedEditCount
      turnsToFirstEdit = tap.turnsToFirstEdit
    },
    instance.swebench?.repo,
  )
  // Drain any in-flight snapshots, then select what to emit. `finalOk` = the
  // agent declared done cleanly; any other reason is the "ran out mid-validate"
  // case the retention targets.
  await snapChain
  const patch = tentativeOn
    ? recorder.selectEmitted(rawPatch, stopReason === "completed")
    : rawPatch
  // T5 — classify on successful SOURCE edits only. Counting failed/blocked
  // attempts, test edits, or scratch edits would misread a no-source-change run
  // as a fork-worktree desync. Classify on `rawPatch`, not tentative `patch`.
  const capture = await classifyPhaseCapture({
    instance,
    sandbox,
    timeoutMs: deps.timeoutMs,
    rawPatch,
    sourceAppliedEditCount,
    totalEditCount: editCount,
    firstEditFile,
    agentError,
  })
  const captureClass = capture.captureClass
  agentError = capture.agentError
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
    captureClass,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(agentError !== undefined ? { agentError } : {}),
    ...(firstEditFile !== undefined ? { firstEditFile } : {}),
    ...(editCount !== undefined ? { editCount } : {}),
    ...(sourceAppliedEditCount !== undefined ? { sourceAppliedEditCount } : {}),
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
  ownerNearRegressionSet: readonly string[],
  verificationTarget: VerificationTargetFact | undefined,
  /** jun-26 repair spec gate: PUBLIC issue-declared expected output (from the
   *  closure session). Only consumed when `QUANTA_BENCH_REPAIR_SPEC_GATE` is on AND
   *  a `primaryRailStep` is set; absent / knob-off ⇒ never read (byte-identical). */
  issueDeclaredExpected: IssueDeclaredExpected | undefined,
  postureOverride?: BenchPosture,
  stateOverride?: BenchKnobState,
  chaRepairTargets?: PreparedAttemptContext["chaRepairTargets"],
  /** Strategy #7 location-set fanout: per-candidate seed factory (built from the
   *  localizer's ranked files). Absent ⇒ breadth candidates share the base seed
   *  (byte-identical). */
  perCandidateSeed?: PerCandidateSeed,
): Promise<Phase> => {
  // jun-25 — suppress the localize-phase EDIT-BLOCK for repair rounds (mirrors
  // the runner-core driver). The fault is already localized in repair (patch
  // exists + failing gate named, seed = "revise the patch now"), so the Phase-1
  // edit-block is a straitjacket that re-fires every fresh repair session and
  // forces ~5 wasted re-localize turns. Resolve the EFFECTIVE posture (override
  // or the env-derived posture `runAgentOnce`→`buildConfig` would otherwise
  // compute) and strip `phase1Turns`; the advisory steer is preserved. INITIAL
  // generation is unchanged.
  const resolvedPosture =
    postureOverride ??
    benchPostureFromState(stateOverride ?? resolveBenchKnobs({ envVars: process.env }), process.env)
  const repairPosture = repairLocalizePhaseSuppressed(resolvedPosture)
  // B1/B3: thread the slice-resolving inputs into the classic-repair packet so
  // its owner evidence carries exact slices (paired with issue symbols) and it
  // names the active proof target — parity with the selector-repair sibling.
  const repairIssueSymbols = extractIssueHint(instance.problemStatement).symbols
  let turns = 0
  let finalPatch = ""
  let repairValidated = false
  let repairFalseGreen = false
  let repairFalseRed = false
  let repairValidationDecision: Phase["repairValidationDecision"]
  let repairRounds = 0
  const repairLlmEvidence: Partial<LlmEvidenceArtifacts> = {}
  // #2 repro-vote: K-of-N RESOLVED majority gate when the knob is on AND a
  // reproducing set exists; else byte-identical `repair.validate ?? defaultValidate`.
  const validate = buildReproVoteValidate(
    instance,
    reproSources,
    repair.validate ?? defaultValidate,
    deps.reproArtifactRootPath,
  )
  // jun-26 repair spec gate / jun-28 strong-oracle (mirror of the runner-core
  // driver): when the issue declares a concrete PUBLIC expected output AND the
  // spec-gate OR strong-oracle knob is on, wrap the typed-predicate evaluator so an
  // exit-0 repair round whose output LACKS the declared expected reads as a
  // predicate `matched:false` (a FALSE GREEN that `isFalseGreen` / the strong-oracle
  // conjunction catch). NO-LEAK: `issueDeclaredExpected` is public-issue-text only.
  // Both knobs OFF ⇒ the raw evaluator (byte-identical); `undefined` expected ⇒
  // `buildSpecGateEvaluatePredicate` returns the identity wrapper.
  const repairEvaluatePredicate = resolveRepairEvaluatePredicate(
    repairPosture,
    issueDeclaredExpected,
    evaluateSuccessPredicate,
  )
  // jun-28 repair-loop BREADTH: when B>1, fan a repair round out to B forked
  // candidates and continue from the one the SAME validator turns green (else the
  // best validator signal). B=1 (default) ⇒ `runCandidates` is undefined ⇒ the
  // orchestrator takes the legacy single `runOnce`+`validate` path (byte-identical).
  const repairBreadth = repair.breadth ?? repairPosture.repairBreadth
  const runCandidates =
    repairBreadth > 1
      ? makeRepairBreadthRunCandidates({
          instanceId: instance.id,
          mainSandbox: sandbox,
          baseCommit: instance.swebench?.baseCommit,
          repo: instance.swebench?.repo,
          timeoutMs: deps.timeoutMs,
          resolveLaneLlm: (index) =>
            applySampleTemperature(
              resolveLaneLlm(deps, repairPosture.modelLaneDiversity, index),
              index,
            ),
          runAgentOnFork: (forkSandbox, seedMsg, laneLlm) =>
            runAgentOnce(
              instance,
              deps,
              forkSandbox,
              signal,
              w,
              seedMsg,
              deps.timeoutMs,
              precomputedHint,
              reproHint,
              closureHint,
              repairPosture,
              stateOverride,
              laneLlm,
            ),
          validate,
          validateInputs: {
            exec,
            timeoutMs: deps.timeoutMs,
            readFile: async (path: string): Promise<string> => Bun.file(path).text(),
            evaluatePredicate: repairEvaluatePredicate,
            ...(primaryRailStep !== undefined ? { primaryRailStep } : {}),
          },
          sandboxPorts: { forkSandbox, cleanupSandbox },
          gitPorts: { resetToBase, applyCandidatePatch, materializeBuildEnv },
          // jun-29 OBSERVE-ONLY pool capture (mirror of the runner driver):
          // persist the FULL candidate pool per round when a run artifact root
          // exists. Decision impact 0; absent root ⇒ no sink ⇒ byte-identical.
          ...(deps.reproArtifactRootPath !== undefined
            ? {
                recordCandidates: (round, candidates) =>
                  writeCandidatePool(
                    deps.reproArtifactRootPath as string,
                    instance.id,
                    round,
                    candidates,
                  ),
              }
            : {}),
          ...(repairPosture.selectorMode === "clean"
            ? {
                deriveCandidateStructuralRepair: (
                  candidate: Candidate,
                  candidateSandbox: string,
                ) =>
                  deriveCandidateStructuralRepair({
                    instance,
                    candidate,
                    sandbox: candidateSandbox,
                    signal,
                    ...(chaRepairTargets !== undefined
                      ? { preferredTargets: chaRepairTargets }
                      : {}),
                  }),
              }
            : {}),
          ...(repairPosture.selectorMode === "clean" &&
          familyCoverageCoeditEnabled(process.env)
            ? {
                repairFamilyCoverage: ({
                  sandbox: candidateSandbox,
                  candidate,
                  family,
                  missingFiles,
                }) =>
                  coeditFamilyCoverageCandidate({
                    sandbox: candidateSandbox,
                    candidate,
                    family,
                    missingFiles,
                    timeoutMs: deps.timeoutMs,
                    baseCommit: instance.swebench?.baseCommit,
                    repo: instance.swebench?.repo,
                    ...(chaRepairTargets !== undefined
                      ? { preferredTargets: chaRepairTargets }
                      : {}),
                  }),
              }
            : {}),
          // #7 location-set fanout: per-candidate lead-file seed (OFF ⇒ undefined
          // ⇒ shared base seed ⇒ byte-identical).
          ...(perCandidateSeed !== undefined ? { perCandidateSeed } : {}),
        })
      : undefined
  // jun-30 SOTA++ acceptance: dual-guard the repair chooser on BOTH the
  // reproducing set and the owner-near PUBLIC regression set that was confirmed
  // green on the base tree during preparation. Empty set ⇒ repro-only legacy.
  const acceptanceSelectCandidates = makeAcceptanceSelectCandidates(
    instance,
    reproSources,
    sandbox,
    deps.timeoutMs,
    repairPosture.acceptance,
    ownerNearRegressionSet,
    resolveAcceptanceLlmRerank(instance, deps.llm, signal),
  )
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const out = await runRepairRounds({
        config: buildRepairRoundsConfig(
          repair.maxRounds,
          repairBreadth,
          repairPosture.repairStrongOracle,
        ),
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
            // Repair posture with the localize-phase edit-block stripped (see
            // `repairLocalizePhaseSuppressed`). Always explicit so `buildConfig`
            // does NOT re-resolve the block-active env posture.
            repairPosture,
            stateOverride,
          ),
        validate,
        buildContext: (ctxArgs) => {
          const repairArgs = {
            ...ctxArgs,
            siblingOwners,
            issueSymbols: repairIssueSymbols,
            readSource: (rel: string) => readSandboxSource(sandbox, rel),
            ...(verificationTarget !== undefined ? { verificationTarget } : {}),
          }
          const repairSeed = buildRepairRoundSeedMessage(
            repairArgs,
            repair.buildContext?.(repairArgs),
          )
          recordLlmEvidencePacket(repairLlmEvidence, repairSeed.packet)
          return repairSeed.seedMsg
        },
        sandbox,
        exec,
        // PARITY with the runner-core driver (src/runner/batch/eval/driver.ts):
        // the repro-rail validator reads the pytest report via `readFile` to
        // classify resolved/red; WITHOUT it `classifyPytestReport` short-circuits
        // to "exec_failed" every round (validator.ts: `readFile === undefined`),
        // so a `repro` primary rail can never clear — the repair loop runs but is
        // inert. Threading the same Bun.file reader makes the rail evaluable.
        readFile: async (path: string): Promise<string> => Bun.file(path).text(),
        timeoutMs: deps.timeoutMs,
        evaluatePredicate: repairEvaluatePredicate,
        ...(primaryRailStep !== undefined ? { primaryRailStep } : {}),
        // jun-28 BREADTH: present only when B>1 (else undefined ⇒ the orchestrator
        // takes the legacy single path, byte-identical).
        ...(runCandidates !== undefined ? { runCandidates } : {}),
        // jun-28 SOTA++ acceptance: present only when the opt-in is on + a repro set
        // exists (else undefined ⇒ legacy validator-rank selection, byte-identical).
        ...(acceptanceSelectCandidates !== undefined
          ? { selectCandidates: acceptanceSelectCandidates }
          : {}),
      })
      turns = out.turns
      finalPatch = out.patch
      repairValidated = out.validated
      repairFalseGreen = out.primaryFalseGreen
      repairFalseRed = out.primaryFalseRed
      repairValidationDecision = out.validationDecision
      repairRounds = out.rounds
    },
    instance.swebench?.repo,
  )
  const capturedPatch = patch !== "" ? patch : finalPatch
  const submissionReview = maybeReviewSubmission(capturedPatch)
  return {
    patch: capturedPatch,
    turns,
    validated: repairValidated,
    primaryFalseGreen: repairFalseGreen,
    primaryFalseRed: repairFalseRed,
    ...(repairValidationDecision !== undefined ? { repairValidationDecision } : {}),
    ...(repairRounds > 0 ? { verifyRounds: repairRounds } : {}),
    ...(Object.keys(repairLlmEvidence).length > 0 ? { llmEvidence: repairLlmEvidence } : {}),
    ...(submissionReview !== undefined ? { submissionReview } : {}),
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

const runAppMainPhase = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
}): Promise<Phase> => {
  if (args.prepared.posture.verifySelectN !== undefined && args.instance.swebench !== undefined) {
    const publicContracts = buildCleanSelectionAuthorityContracts({
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
      args.prepared.existingTestExpectations,
      args.prepared.reproTest,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaRepairTargets,
    )
  }
  if (args.prepared.runRepair && args.prepared.effectiveRepair !== undefined) {
    const repairFanoutFiles = buildRepairFanoutFiles({
      localizeCandidates: args.prepared.localizeCandidates,
      stage1Files: args.prepared.closureSession?.input.evidence.stage1Files,
      ownerResolved: args.prepared.ownerResolved,
      witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
    })
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
      args.prepared.ownerNearRegressionSet,
      verificationTargetFromPlan(args.prepared.verificationPlan),
      args.prepared.closureSession?.issueDeclaredExpected,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaRepairTargets,
      resolveLocationFanoutSeeder(
        repairFanoutFiles,
        args.prepared.effectiveRepair.breadth ?? args.prepared.posture.repairBreadth,
        buildRepairFanoutSymbols({
          issueSymbols: extractIssueHint(args.instance.problemStatement).symbols,
          fanoutFiles: repairFanoutFiles,
          ownerResolved: args.prepared.ownerResolved,
          witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
        }),
      ),
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

/**
 * v5 adaptive-routing attempt — extracted verbatim from `runInstanceOnce` (keeps
 * that body under the god-function line cap). Behaviour-identical: the `onPhase`/
 * `onPrepared` callbacks reproduce the original in-place mutation of the caller's
 * `phase`/`prepared` (used by the caller's catch-path classification), and all
 * exceptions propagate to the caller's try/catch exactly as before.
 */
const runAdaptiveAttempt = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly startedAt: number
  readonly onPhase: (phase: Phase) => void
  readonly onPrepared: (prepared: PreparedAttemptContext) => void
}): Promise<InstanceResult> => {
  const { instance, deps, sandbox, signal, wiring, reproTest, startedAt } = args
  const preparedContext = args.prepared
  const thinPhase = await runAppMainPhase({
    instance,
    deps,
    sandbox,
    signal,
    wiring,
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
  const effortLimits = resolveEffortLadderLimits(process.env)
  const adaptive = await runAdaptiveBenchAttempt({
    intakePacket: initialPacket,
    base: preparedContext.state,
    env: process.env,
    modelCall: buildAdaptiveRouterModelCall({ basePort: deps.llm, env: process.env, signal }),
    runPhase: async ({ state, posture }) => {
      const widening = await adaptiveNextPassOwners({
        prepared: finalPrepared,
        phase: finalPhase,
        forwardLocalize: posture.forwardLocalize,
        sandbox,
        timeoutMs: deps.timeoutMs,
      })
      const nextPrepared = await prepareAttemptContext(
        instance,
        sandbox,
        deps,
        signal,
        posture,
        state,
        widening.owners,
      )
      const nextPhase = await runAppMainPhase({
        instance,
        deps,
        sandbox,
        signal,
        wiring,
        prepared: nextPrepared,
      })
      if (widening.telemetry !== undefined) nextPhase.ownerWidening = widening.telemetry
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
    // #8 effort ladder: raise the bounded-loop ceiling by the opt-in tier (OFF ⇒
    // undefined ⇒ DEFAULT_ADAPTIVE_LIMITS ⇒ byte-identical).
    ...(effortLimits !== undefined ? { limits: effortLimits } : {}),
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
  args.onPhase(finalPhase)
  args.onPrepared(finalPrepared)
  const terminal = await maybeValidateTerminalResult({
    instance,
    phase: finalPhase,
    reproTest,
    deps,
    wiring,
    startedAt,
    signal,
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
      signal,
      reproTest,
      wiring,
      startedAt,
      prepared: finalPrepared,
    })),
    adaptiveRoute,
  }
}

interface RunInstanceOnceState {
  phase: Phase
  wiring: Wiring
  reproTest?: BenchReproTestTelemetry
  prepared?: PreparedAttemptContext
  deadline?: ReturnType<typeof setTimeout>
}

const preparedFailureContext = (
  state: RunInstanceOnceState,
  sandbox: string,
): { readonly prepared?: PreparedAttemptContext; readonly sandbox?: string } =>
  state.prepared === undefined ? {} : { prepared: state.prepared, sandbox }

const lspDegradedResult = (
  instance: Instance,
  sandbox: string,
  state: RunInstanceOnceState,
  error: StrictLspGroundingDegradedError,
): InstanceResult => {
  const degraded = latePhaseFailureResultOf({
    instance,
    phase: state.phase,
    reproTest: state.reproTest,
    verdict: "degraded",
    error: error.message,
    ...preparedFailureContext(state, sandbox),
  })
  // LSP-02: the gate threw before a PreparedAttemptContext existed, so the typed
  // status would otherwise be lost on this LIVE degrade path. Attach it straight
  // from the receipt so the report row carries the launch/ready outcome enum, not
  // just the error string.
  const status = error.receipt !== undefined ? foldGroundingReceipts([error.receipt]) : undefined
  return status !== undefined ? { ...degraded, lspGrounding: status } : degraded
}

const runInstanceFailureResult = (
  instance: Instance,
  sandbox: string,
  state: RunInstanceOnceState,
  error: unknown,
): InstanceResult => {
  if (error instanceof ObservationError) {
    return latePhaseFailureResultOf({
      instance,
      phase: state.phase,
      reproTest: state.reproTest,
      verdict: "degraded",
      error: `observation failed (strict): ${error.message}`,
      ...preparedFailureContext(state, sandbox),
    })
  }
  if (error instanceof StrictLspGroundingDegradedError) {
    return lspDegradedResult(instance, sandbox, state, error)
  }
  if (error instanceof PacketBlindnessViolation) {
    return latePhaseFailureResultOf({
      instance,
      phase: state.phase,
      reproTest: state.reproTest,
      verdict: "degraded",
      error: `evidence packet blindness violation (build aborted): ${error.message}`,
      ...preparedFailureContext(state, sandbox),
    })
  }
  return latePhaseFailureResultOf({
    instance,
    phase: state.phase,
    reproTest: state.reproTest,
    error: errMessage(error),
    ...preparedFailureContext(state, sandbox),
  })
}

const runInstanceBody = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly abort: AbortController
  readonly startedAt: number
  readonly state: RunInstanceOnceState
}): Promise<InstanceResult> => {
  args.state.wiring = buildWiring(args.instance, args.deps.observe)
  await copyRepo(args.instance, args.sandbox)

  const prep = await runEnvPrep(args.instance, args.sandbox, args.deps.timeoutMs)
  if (!prep.ok) return envPrepFailedResult(args.instance, prep)
  if (args.instance.swebench?.repo !== undefined) {
    await materializeBuildEnv(args.sandbox, args.instance.swebench.repo)
  }

  args.state.prepared = await prepareAttemptContext(
    args.instance,
    args.sandbox,
    args.deps,
    args.abort.signal,
  )
  const preparedContext = args.state.prepared
  if (preparedContext.reproTest !== undefined) args.state.reproTest = preparedContext.reproTest
  args.state.deadline = setTimeout(() => args.abort.abort(), args.deps.timeoutMs)

  if (v5AdaptiveEnabled({ preset: preparedContext.state.preset, envVars: process.env })) {
    return attachAndPersistReproVoteOutcomes(
      await runAdaptiveAttempt({
        instance: args.instance,
        deps: args.deps,
        sandbox: args.sandbox,
        signal: args.abort.signal,
        wiring: args.state.wiring,
        prepared: preparedContext,
        reproTest: args.state.reproTest,
        startedAt: args.startedAt,
        onPhase: (phase) => {
          args.state.phase = phase
        },
        onPrepared: (prepared) => {
          args.state.prepared = prepared
        },
      }),
    )
  }

  args.state.phase = await runAppMainPhase({
    instance: args.instance,
    deps: args.deps,
    sandbox: args.sandbox,
    signal: args.abort.signal,
    wiring: args.state.wiring,
    prepared: preparedContext,
  })
  const followup = await maybeRunRepairEscalationFollowup({
    instance: args.instance,
    deps: args.deps,
    sandbox: args.sandbox,
    signal: args.abort.signal,
    prepared: preparedContext,
    phase: args.state.phase,
    runPhase: (nextPrepared) =>
      runAppMainPhase({
        instance: args.instance,
        deps: args.deps,
        sandbox: args.sandbox,
        signal: args.abort.signal,
        wiring: args.state.wiring,
        prepared: nextPrepared,
      }),
  })
  args.state.prepared = followup.prepared
  args.state.phase = followup.phase
  if (followup.prepared.reproTest !== undefined) args.state.reproTest = followup.prepared.reproTest
  if (followup.telemetry !== undefined) args.state.phase.ownerWidening = followup.telemetry
  const terminal = await maybeValidateTerminalResult({
    instance: args.instance,
    phase: args.state.phase,
    reproTest: args.state.reproTest,
    deps: args.deps,
    wiring: args.state.wiring,
    startedAt: args.startedAt,
    signal: args.abort.signal,
    prepared: args.state.prepared,
    sandbox: args.sandbox,
  })
  if (terminal !== undefined) return attachAndPersistReproVoteOutcomes(terminal)

  // Await inside the try so sandbox cleanup in `finally` cannot race the final
  // verifier. A bare `return promise` here would run `finally` immediately and
  // tear down the sandbox while verify is still spawning.
  return attachAndPersistReproVoteOutcomes(
    await verifyAndFinalizeResult({
      instance: args.instance,
      phase: args.state.phase,
      deps: args.deps,
      sandbox: args.sandbox,
      signal: args.abort.signal,
      reproTest: args.state.reproTest,
      wiring: args.state.wiring,
      startedAt: args.startedAt,
      prepared: args.state.prepared,
    }),
  )
}

const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  // A5: reset the repro-vote sink at instance START so this instance's vote
  // outcomes cannot leak into the next instance's telemetry (the audit's
  // cross-instance accumulation risk). Drained per result via
  // `attachAndPersistReproVoteOutcomes`.
  resetReproVoteOutcomes()
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  // Attempt-scoped bench budget: one meter spans the nested agent runs inside
  // THIS attempt (repair rounds, breadth candidates, verify-select generation),
  // so batch dials bound aggregate churn instead of resetting on every internal
  // `runAgent` invocation.
  const attemptBudgetMeter = (
    deps.budgetMeterFactory ?? (() => benchBudgetMeterFromEnv(process.env))
  )()
  const effectiveDeps: RunInstanceDeps = {
    ...deps,
    budgetMeterFactory: () => attemptBudgetMeter,
  }
  // The per-instance wall-clock deadline bounds the AGENT SOLVE only — NOT env
  // setup (copyRepo + setupCmd + hint/repro install), which have their own
  // timeouts (runEnvPrep). Starting the timer here (pre-setup) let cold-start
  // overhead eat the agent's think budget and abort it mid-solve under
  // concurrency (observed: 68% spurious aborts). The timer is armed below, once
  // setup is done, so the agent always gets the full `timeoutMs`.
  const startedAt = Date.now()
  const state: RunInstanceOnceState = {
    phase: { patch: "", turns: 0 },
    wiring: { stream: new NullStream() },
  }
  try {
    return await runInstanceBody({
      instance,
      deps: effectiveDeps,
      sandbox,
      abort,
      startedAt,
      state,
    })
  } catch (error) {
    return attachAndPersistReproVoteOutcomes(
      runInstanceFailureResult(instance, sandbox, state, error),
    )
  } finally {
    clearTimeout(state.deadline)
    state.wiring.observer?.close()
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

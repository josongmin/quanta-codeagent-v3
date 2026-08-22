import {
  resolveEffortLadderLimits,
  runAdaptiveBenchAttempt,
} from "@/runner/batch/eval/adaptive-escalation"
import { buildAdaptiveRouterModelCall } from "@/runner/batch/eval/adaptive-escalation/live-model-call"
import {
  adaptiveNextPassOwners,
  applyBenchKnobs,
  attachAndPersistReproVoteOutcomes,
  type BenchKnobState,
  BenchObserver,
  benchBudgetMeterFromEnv,
  benchOptIns,
  buildAdaptivePhasePacket,
  buildConfig as buildRunnerConfig,
  composeWithReproHint,
  DEFAULT_POLICY,
  enumerateRepoSources,
  envPrepFailedResult,
  type IssueHintMode,
  knobsForReport,
  latePhaseFailureResultOf,
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
  reproHintMessage,
  resetReproVoteOutcomes,
  resolveBenchKnobs,
  runRetryLoop,
  StrictLspGroundingDegradedError,
  selectionReproPrepK,
  UsageTap,
  verifyAndFinalizeResult,
} from "@/runner/batch/eval/driver"
import { PacketBlindnessViolation } from "@/runner/batch/eval/llm-evidence-packet"
import { materializeBuildEnv } from "@/runner/batch/eval/rematerialize"
import {
  benchInstallsReproHint,
  benchRunsRepairPhase,
} from "@/runner/batch/eval/repair-phase-policy"
import { errMessage, foldGroundingReceipts } from "@/shared"
import { v5AdaptiveEnabled } from "../preset"
import { patchRunMeta } from "../trajectory"
import { isTrajectoryDebugEnabled } from "../trajectory-debug-sink"
import type { BenchReproTestTelemetry, Instance, InstanceResult } from "../types"
import { contributeVerdictDebug, type Phase } from "./driver/agent-phase"
import { runAppMainPhase } from "./driver/app-main"
import type { RunInstanceDeps } from "./driver/deps"
import { runEnvPrep } from "./env-prep"
import { buildWiring, NullStream, ObservationError, type Wiring } from "./report"
import { cleanupSandbox, copyRepo, createSandbox } from "./sandbox"

// Public surface preserved across the driver-lane split (refactor/bench-driver-lanes):
// the debug enrichers, the terminal-event helper and the verify-select repro policy
// moved into `./driver/*` lane modules but stay importable from this barrel exactly
// as before (byte-identical logic, re-exported here for backwards-compatible imports).
export {
  captureLostEditsError,
  contributeEditTraceDebug,
  contributeVerdictDebug,
  lastTerminalTurnEventOf,
} from "./driver/agent-phase"
export { type SelectionReproPolicy, selectionReproPolicy } from "./driver/selection"
export type {
  BenchKnobState,
  IssueHintMode,
  PrepareIssueHintDeps,
  PrepareReproTestDeps,
  RunInstanceDeps,
}
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
        wiring.observer, // F1: localize trace on the adaptive re-prepare too
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
  const finalResult = await verifyAndFinalizeResult({
    instance,
    phase: finalPhase,
    deps,
    sandbox,
    signal,
    reproTest,
    wiring,
    startedAt,
    prepared: finalPrepared,
  })
  if (isTrajectoryDebugEnabled()) {
    void patchRunMeta(instance.id, {
      verdict: { passed: finalResult.passed, patchBytes: finalResult.patch.length },
    })
    // DEBUG enricher `verdict` (jul-08 platform, enricher order verdict > editTrace >
    // toolExec): contribute the grade/verify outcome into the CURRENT lane's debug
    // buffer so it rides `metadata.debug.verdict` alongside the recorded LLM turn —
    // exactly like `toolExec`. Metadata-only ⇒ replay-neutral (never touches the
    // request hash). No-op unless the debug gate is on.
    contributeVerdictDebug(finalResult)
  }
  return { ...finalResult, adaptiveRoute }
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
    undefined,
    undefined,
    undefined,
    // F1: light up the localize file-tree/truncation trace (no-op if unbound).
    args.state.wiring.observer,
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
  const onceResult = await verifyAndFinalizeResult({
    instance: args.instance,
    phase: args.state.phase,
    deps: args.deps,
    sandbox: args.sandbox,
    signal: args.abort.signal,
    reproTest: args.state.reproTest,
    wiring: args.state.wiring,
    startedAt: args.startedAt,
    prepared: args.state.prepared,
  })
  if (isTrajectoryDebugEnabled()) {
    void patchRunMeta(args.instance.id, {
      verdict: { passed: onceResult.passed, patchBytes: onceResult.patch.length },
    })
    // DEBUG enricher `verdict` (see contributeVerdictDebug): ride the grade outcome
    // on `metadata.debug.verdict` of the recorded turn, mirroring `toolExec`.
    contributeVerdictDebug(onceResult)
  }
  return attachAndPersistReproVoteOutcomes(onceResult)
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

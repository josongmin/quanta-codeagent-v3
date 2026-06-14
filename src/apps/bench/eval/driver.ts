import { type AgentConfig, type AgentOutcome, runAgent, wireOptionalAgentPorts } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import type { LLMPort, Message } from "@/llm"
import type { CapabilityManifest, SessionEvent } from "@/protocol/session"
import {
  applyBenchKnobs,
  type BenchKnobState,
  BenchObserver,
  benchOptIns,
  buildConfig as buildRunnerConfig,
  composeWithReproHint,
  DEFAULT_POLICY,
  enumerateRepoSources,
  type IssueHintMode,
  knobsForReport,
  type PrepareIssueHintDeps,
  type PrepareReproTestDeps,
  parseBenchBranchSearchK,
  parseBenchReproTestK,
  parseLocalizePhaseEnv,
  prepareIssueHint,
  prepareReproTest,
  prepareReproTestDetailed,
  projectOutcome,
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  runRetryLoop,
  type RunInstanceDeps as SharedRunInstanceDeps,
  UsageTap,
} from "@/runner/batch/eval/driver"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import { errMessage } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import type { BenchReproTestTelemetry, Instance, InstanceResult } from "../types"
import { runEnvPrep } from "./env-prep"
import { exec } from "./exec"
import { buildRepairContext } from "./repair/context"
import { runRepairRounds } from "./repair/index"
import type { RunOnceResult } from "./repair/types"
import { validate as defaultValidate } from "./repair/validator"
import {
  buildWiring,
  emitPatch,
  emitSandbox,
  emitVerify,
  NullStream,
  ObservationError,
  type Wiring,
} from "./report"
import { cleanupSandbox, copyRepo, createSandbox } from "./sandbox"
import { gitStageAndDiffCached, withGitSnapshot } from "./snapshot"
import { verify } from "./verdict"

export type { BenchKnobState, IssueHintMode, PrepareIssueHintDeps, PrepareReproTestDeps }
export {
  applyBenchKnobs,
  BenchObserver,
  benchOptIns,
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
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
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
    if (outcome === undefined) throw new Error("bench SDK session completed without an outcome")
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

interface InstallReproTestResult {
  readonly hint: string | undefined
  readonly telemetry: BenchReproTestTelemetry | undefined
}

const writeFailedTelemetry = (base: BenchReproTestTelemetry): BenchReproTestTelemetry => ({
  installed: false,
  reason: "write_failed",
  ...(base.samples !== undefined ? { samples: base.samples } : {}),
  ...(base.reproducedCount !== undefined ? { reproducedCount: base.reproducedCount } : {}),
})

const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
): Promise<InstallReproTestResult> => {
  // Unified posture: K resolves from the preset/env via the knob framework
  // (preset `agentless-v1` ⇒ K=5; explicit QUANTA_BENCH_REPRO_TEST overrides).
  const reproK = benchOptIns().reproTestK
  if (reproK === undefined) return { hint: undefined, telemetry: undefined }
  const preparation = await prepareReproTestDetailed(instance, sandbox, reproK, { llm })
  const { selection, telemetry } = preparation
  if (selection === null || selection.selected === null) return { hint: undefined, telemetry }
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    await Bun.write(path, selection.selected)
    return {
      hint: REPRO_HINT_MESSAGE,
      telemetry: {
        installed: true,
        path,
        samples: selection.samples.length,
        reproducedCount: selection.reproducedCount,
      },
    }
  } catch (_writeErr) {
    return { hint: undefined, telemetry: writeFailedTelemetry(telemetry) }
  }
}

interface Phase {
  patch: string
  turns: number
}

class LastVerifyCmdTap implements StreamPort {
  lastVerifyCmd: string | undefined

  constructor(private readonly downstream: StreamPort) {}

  emit(event: AgentEvent): void {
    if (event.type === "tool_call") {
      if (event.name === "bash") {
        const input = event.input
        if (typeof input === "object" && input !== null && "command" in input) {
          const cmd = (input as { command: unknown }).command
          if (typeof cmd === "string" && cmd !== "") this.lastVerifyCmd = cmd
        }
      } else if (event.name === "test_runner") {
        this.lastVerifyCmd = "test_runner"
      }
    }
    this.downstream.emit(event)
  }
}

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
): Promise<RunOnceResult> => {
  const tap = new LastVerifyCmdTap(w.stream)
  const outcome = await runAgentViaSdk(
    buildRunnerConfig(instance, deps, sandbox, signal, tap, seedMsg, precomputedHint, reproHint),
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
): Promise<Phase> => {
  let turns = 0
  const patch = await withGitSnapshot(
    sandbox,
    deps.timeoutMs,
    instance.swebench?.baseCommit,
    async () => {
      await emitSandbox(w.observer, sandbox, instance.swebench?.baseCommit, deps.timeoutMs)
      const outcome = await runAgentViaSdk(
        buildRunnerConfig(
          instance,
          deps,
          sandbox,
          signal,
          w.stream,
          undefined,
          precomputedHint,
          reproHint,
        ),
        deps.runtimeFactory,
      )
      turns = outcome.turns
    },
  )
  return { patch, turns }
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
): Promise<Phase> => {
  let turns = 0
  let finalPatch = ""
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
          ),
        validate: repair.validate ?? defaultValidate,
        buildContext: repair.buildContext ?? buildRepairContext,
        sandbox,
        exec,
        timeoutMs: deps.timeoutMs,
      })
      turns = out.turns
      finalPatch = out.patch
    },
  )
  return { patch: patch !== "" ? patch : finalPatch, turns }
}

const okResult = (
  instance: Instance,
  phase: Phase,
  v: { passed: boolean; error?: string },
  extra: Partial<InstanceResult>,
): InstanceResult => ({
  id: instance.id,
  passed: v.passed,
  patch: phase.patch,
  turns: phase.turns,
  ...(v.error !== undefined ? { error: v.error } : {}),
  ...extra,
})

const reproResultExtra = (
  reproTest: BenchReproTestTelemetry | undefined,
): Partial<InstanceResult> => (reproTest === undefined ? {} : { reproTest })

const runInstanceOnce = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
  let reproTest: BenchReproTestTelemetry | undefined
  try {
    w = buildWiring(instance, deps.observe)
    await copyRepo(instance, sandbox)

    const prep = await runEnvPrep(instance, sandbox, deps.timeoutMs)
    if (!prep.ok) {
      return {
        id: instance.id,
        passed: false,
        patch: "",
        turns: 0,
        verdict: "env_prep_failed",
        error: `env prep (setupCmd) failed (code ${prep.code}): ${prep.stderr.slice(0, 500)}`,
      }
    }

    const hintMode = benchOptIns().issueHintMode
    const precomputedHint = await prepareIssueHint(instance, sandbox, hintMode, { llm: deps.llm })
    const reproInstall = await installReproTestHint(instance, sandbox, deps.llm)
    const reproHint = reproInstall.hint
    reproTest = reproInstall.telemetry

    phase =
      deps.repair !== undefined && instance.swebench !== undefined
        ? await runRepairPhase(
            instance,
            deps,
            sandbox,
            abort.signal,
            w,
            deps.repair,
            precomputedHint,
            reproHint,
          )
        : await runAgentPhase(instance, deps, sandbox, abort.signal, w, precomputedHint, reproHint)

    const v = await verify(instance, phase.patch, sandbox, deps)
    const extra: Partial<InstanceResult> = reproResultExtra(reproTest)
    if (deps.observe && w.observer) {
      extra.verdict = "ok"
      extra.durationMs = Date.now() - startedAt
      extra.patchPath = emitPatch(deps.observe, instance, w.observer, phase.patch)
      emitVerify(w.observer, v)
      const usage = w.usage?.total()
      if (usage) extra.usage = usage
    }
    return okResult(instance, phase, v, extra)
  } catch (error) {
    if (error instanceof ObservationError) {
      return {
        id: instance.id,
        passed: false,
        patch: phase.patch,
        turns: phase.turns,
        verdict: "degraded",
        error: `observation failed (strict): ${error.message}`,
        ...reproResultExtra(reproTest),
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: errMessage(error),
      ...reproResultExtra(reproTest),
    }
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
      adaptedTimeoutMs: deps.timeoutMs,
      attempts: loop.attempts,
      attemptOutcomes: loop.outcomes.map(projectOutcome),
    },
  }
}

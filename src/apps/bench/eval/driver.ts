import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
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
  REPRO_FILE_NAME,
  REPRO_HINT_MESSAGE,
  readKnobValue,
  resolveBenchKnobs,
  type RunInstanceDeps as SharedRunInstanceDeps,
  UsageTap,
} from "@/runner/batch/eval/driver"
import { createRuntime, type RuntimeSession } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Instance, InstanceResult } from "../types"
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
  const sessionId = `bench-${crypto.randomUUID()}`
  return {
    describe: () => ({
      sessionId,
      permissionMode: config.permission.mode,
      capabilityManifest: capabilityManifestForConfig(config),
      identityMode: "default",
      toolProfile: "write",
    }),
    runTurn: async ({ signal }) => {
      const result = await runAgent({
        ...config,
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

const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
): Promise<string | undefined> => {
  const reproK = parseBenchReproTestK(process.env.QUANTA_BENCH_REPRO_TEST)
  if (reproK === undefined) return undefined
  const selection = await prepareReproTest(instance, sandbox, reproK, { llm })
  if (selection === null || selection.selected === null) return undefined
  try {
    await Bun.write(`${sandbox}/${REPRO_FILE_NAME}`, selection.selected)
    return REPRO_HINT_MESSAGE
  } catch {
    return undefined
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

export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await createSandbox(instance)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  const startedAt = Date.now()
  let phase: Phase = { patch: "", turns: 0 }
  let w: Wiring = { stream: new NullStream() }
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
    const reproHint = await installReproTestHint(instance, sandbox, deps.llm)

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
    const extra: Partial<InstanceResult> = {}
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
      }
    }
    return {
      id: instance.id,
      passed: false,
      patch: phase.patch,
      turns: phase.turns,
      error: (error as Error).message,
    }
  } finally {
    clearTimeout(deadline)
    w.observer?.close()
    await cleanupSandbox(sandbox)
  }
}

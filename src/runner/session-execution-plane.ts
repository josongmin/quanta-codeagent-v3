import {
  buildSubagentForkOnAccept,
  defaultProposeHandler,
  defaultStuckDetector,
} from "@/agent/auto-background"
import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { defaultDelegationRunner } from "@/agent/delegation-runner"
import { defaultCheckpointBaseWire } from "@/agent/fork-session-wire"
import type {
  BackgroundSubagentScheduler,
  SubagentResult,
  SubagentStatus,
} from "@/agent/subagent-background"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import {
  defaultJsonlSchedulerStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"
import { defaultResumePolicy, resumeInterruptedHandles } from "@/agent/subagent-resume"
import { createSubagentRunner } from "@/agent/subagent-runner"
import {
  AGENT_MODES,
  type DelegationPort,
  lookupModeProfile,
  wrapSubagentRunner,
} from "@/agent/subagent-typed"
import type { AgentConfig } from "@/agent/types"
import {
  defaultResponsesContinuationStore,
  type Message,
  type ResponsesContinuationStore,
  responsesContinuationLlmPort,
} from "@/llm"
import { gateOn, runtimeConfigFromEnv } from "@/shared"
import { assembleConfig, type SessionDeps } from "./assemble/config"

export interface SharedExecutionPlaneArgs {
  readonly history: readonly Message[]
  readonly sessionDeps: SessionDeps
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
}

type SharedExecutionPlaneDeps = Pick<
  AgentConfig,
  | "llm"
  | "conversationCheckpoint"
  | "responsesContinuation"
  | "fork"
  | "forkSession"
  | "delegation"
  | "subagentBackground"
  | "autoBackground"
>

export interface SharedExecutionPlaneRuntimeArgs {
  readonly history: readonly Message[]
  readonly parentConfig: AgentConfig
  readonly subagentConfig?: AgentConfig["subagent"]
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
}

const normalizeBgStatus = (status: string): SubagentStatus =>
  status === "interrupted" || status === "resumed" ? "failed" : (status as SubagentStatus)

const normalizeBgResult = (result: {
  readonly status: string
  readonly outputSummary: string
  readonly outputDetail?: string
  readonly errorMessage?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly turns: number
}): SubagentResult => ({
  status: normalizeBgStatus(result.status),
  outputSummary: result.outputSummary,
  ...(result.outputDetail !== undefined ? { outputDetail: result.outputDetail } : {}),
  ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
  startedAt: result.startedAt,
  ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : {}),
  turns: result.turns,
})

const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const adaptDelegation = (
  cfg: Parameters<typeof createSubagentRunner>[0],
  maxDepth: number | undefined,
): NonNullable<SessionDeps["delegation"]> => {
  const subagentRunner = createSubagentRunner(cfg, maxDepth !== undefined ? { maxDepth } : {})
  // RFC jul-13 P0-b (correctness): thread THIS agent's depth (0 = root) so a
  // delegate child gets `parentDepth + 1`, NOT a hardcoded 0 — mirrors
  // `agent-arg-builder.resolveDelegation` + the foreground `buildChildConfig`
  // convention. Feeds the delegation-runner MAX_DEPTH gate (spec.depth) AND the
  // wrapped SubagentRequest depth (runtime `req.depth > maxDepth` reject).
  const parentDepth = cfg.depth ?? 0
  const runner = defaultDelegationRunner({
    runner: wrapSubagentRunner(subagentRunner, parentDepth),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  })
  const delegator: DelegationPort = {
    delegate: async (req) =>
      runner.delegate({
        mode: req.mode,
        prompt: req.prompt,
        ...(req.budget !== undefined ? { budget: req.budget } : {}),
        ...(req.parentSignal !== undefined ? { signal: req.parentSignal } : {}),
        ...(req.correlation !== undefined ? { correlation: req.correlation } : {}),
        depth: parentDepth + 1,
      }),
    listModes: () => AGENT_MODES,
    describeMode: (mode) => lookupModeProfile(mode),
  }
  return { delegator, modes: AGENT_MODES }
}

const createPersistentBackgroundScheduler = async (
  args: SharedExecutionPlaneRuntimeArgs,
  subagentConfig: NonNullable<AgentConfig["subagent"]>,
) => {
  const childRunner = createSubagentRunner(
    args.parentConfig,
    subagentConfig.maxDepth !== undefined ? { maxDepth: subagentConfig.maxDepth } : {},
  )
  const maxConcurrent = parsePositiveInt(args.envSource.QUANTA_BG_MAX_CONCURRENT)
  const maxRetained = parsePositiveInt(args.envSource.QUANTA_BG_MAX_RETAINED)
  const admissionQueue = gateOn(args.envSource, "QUANTA_SUBAGENT_QUEUE")
  const maxQueued = parsePositiveInt(args.envSource.QUANTA_BG_MAX_QUEUED)
  const parentDepth = args.parentConfig.depth ?? 0
  const childDepth = parentDepth + 1
  const inner = defaultBackgroundSubagentScheduler({
    runner: childRunner,
    parentDepth,
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(maxRetained !== undefined ? { maxRetained } : {}),
    ...(admissionQueue ? { admissionQueue: true } : {}),
    ...(admissionQueue && maxQueued !== undefined ? { maxQueued } : {}),
  })
  const store = defaultJsonlSchedulerStore(
    args.envSource.QUANTA_BG_STORE_DIR !== undefined
      ? { baseDir: args.envSource.QUANTA_BG_STORE_DIR }
      : undefined,
  )
  const persistent = await persistentBackgroundSubagentScheduler({
    inner,
    store,
    workspace: args.cwd,
    childDepth,
  })
  return { persistent, store, childDepth }
}

const resumeInterruptedBackgroundHandles = async (
  args: SharedExecutionPlaneRuntimeArgs,
  persistent: Awaited<ReturnType<typeof persistentBackgroundSubagentScheduler>>,
  store: ReturnType<typeof defaultJsonlSchedulerStore>,
  childDepth: number,
): Promise<void> => {
  if (!runtimeConfigFromEnv(args.envSource).subagentResume) return
  const outcomes = await resumeInterruptedHandles({
    scheduler: persistent,
    store,
    policy: defaultResumePolicy(),
    workspace: args.cwd,
    lineageGuard: { resumeForkDepth: childDepth },
  })
  for (const outcome of outcomes) {
    if (outcome.decision.action === "resume" || outcome.decision.action === "mark-failed") {
      persistent.evictInterrupted(outcome.id)
    }
  }
}

const publicBackgroundScheduler = (
  persistent: Awaited<ReturnType<typeof persistentBackgroundSubagentScheduler>>,
): BackgroundSubagentScheduler => ({
  fork: (spec) => persistent.fork(spec),
  poll: (id) => {
    const result = persistent.poll(id)
    return result === null ? null : normalizeBgResult(result)
  },
  await: async (id, opts) => {
    const result = await persistent.await(id, opts)
    return result === null ? null : normalizeBgResult(result)
  },
  cancel: (id) => persistent.cancel(id),
  forceBackground: (id, forceOpts) => persistent.forceBackground(id, forceOpts),
  list: () =>
    persistent.list().map((entry) => ({
      ...entry,
      result: normalizeBgResult(entry.result),
    })),
  prune: (maxAgeMs) => persistent.prune(maxAgeMs),
  serialize: () => persistent.serialize(),
  hydrate: (json) => persistent.hydrate(json),
  hydrateWithPrune: (json, maxAgeMs) => persistent.hydrateWithPrune(json, maxAgeMs),
})

const autoBackgroundDeps = (
  scheduler: BackgroundSubagentScheduler,
  envSource: Readonly<Record<string, string | undefined>>,
) => {
  const thresholdMs = parsePositiveInt(envSource.QUANTA_AUTO_BACKGROUND_THRESHOLD_MS)
  const detector = defaultStuckDetector(thresholdMs !== undefined ? { thresholdMs } : {})
  const onAccept = buildSubagentForkOnAccept({ scheduler })
  const proposer = defaultProposeHandler({
    detector,
    ...(onAccept !== undefined ? { onAccept } : {}),
  })
  return {
    detector,
    proposer,
    ...(thresholdMs !== undefined ? { thresholdMs } : {}),
    ...(onAccept !== undefined ? { onAccept } : {}),
  }
}

export const buildSharedExecutionPlaneSessionDeps = async (
  args: SharedExecutionPlaneArgs,
): Promise<Partial<SharedExecutionPlaneDeps>> => {
  const parentConfig = assembleConfig([...args.history], args.sessionDeps)
  return await buildSharedExecutionPlaneRuntimeAugments({
    history: args.history,
    parentConfig,
    subagentConfig: args.sessionDeps.subagentConfig,
    cwd: args.cwd,
    envSource: args.envSource,
    ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
    ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
  })
}

export const buildSharedExecutionPlaneRuntimeAugments = async (
  args: SharedExecutionPlaneRuntimeArgs,
): Promise<Partial<SharedExecutionPlaneDeps>> => {
  const convStore = args.convStore ?? defaultConversationCheckpointStore()
  const responsesStore = args.responsesStore ?? defaultResponsesContinuationStore()
  const forkWire = defaultCheckpointBaseWire({ store: convStore })
  const base: Partial<SharedExecutionPlaneDeps> = {
    llm: responsesContinuationLlmPort({ inner: args.parentConfig.llm, store: responsesStore }),
    conversationCheckpoint: { store: convStore },
    responsesContinuation: { store: responsesStore },
    fork: { forker: forkWire.base },
    forkSession: { forker: forkWire.forker },
  }

  const subagentCfg = args.subagentConfig
  if (subagentCfg === undefined) return base
  const { persistent, store, childDepth } = await createPersistentBackgroundScheduler(
    args,
    subagentCfg,
  )
  await resumeInterruptedBackgroundHandles(args, persistent, store, childDepth)
  const scheduler = publicBackgroundScheduler(persistent)

  return {
    ...base,
    delegation: adaptDelegation(args.parentConfig, subagentCfg.maxDepth),
    subagentBackground: { scheduler },
    autoBackground: autoBackgroundDeps(scheduler, args.envSource),
  }
}

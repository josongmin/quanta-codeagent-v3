import type { AgentConfig } from "@/agent"
import {
  buildSubagentForkOnAccept,
  defaultProposeHandler,
  defaultStuckDetector,
} from "@/agent/auto-background"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
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
import { createSubagentRunner } from "@/agent/subagent-runner"
import {
  AGENT_MODES,
  type DelegationPort,
  lookupModeProfile,
  wrapSubagentRunner,
} from "@/agent/subagent-typed"
import { assembleConfig, type SessionDeps } from "../internal"
import type { SessionSetupResult } from "./session-setup"

export interface ExecutionPlaneWireArgs {
  readonly setup: SessionSetupResult
  readonly convStore: ConversationCheckpointStore
  readonly envSource: NodeJS.ProcessEnv
}

type ExecutionPlaneSessionDeps = Pick<
  SessionDeps,
  | "conversationCheckpoint"
  | "fork"
  | "forkSession"
  | "delegation"
  | "subagentBackground"
  | "autoBackground"
>

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
  cfg: AgentConfig,
  maxDepth: number | undefined,
): NonNullable<SessionDeps["delegation"]> => {
  const subagentRunner = createSubagentRunner(cfg, maxDepth !== undefined ? { maxDepth } : {})
  const runner = defaultDelegationRunner({
    runner: wrapSubagentRunner(subagentRunner),
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
        depth: 0,
      }),
    listModes: () => AGENT_MODES,
    describeMode: (mode) => lookupModeProfile(mode),
  }
  return { delegator, modes: AGENT_MODES }
}

export const buildExecutionPlaneSessionDeps = async (
  args: ExecutionPlaneWireArgs,
): Promise<Partial<ExecutionPlaneSessionDeps>> => {
  const forkWire = defaultCheckpointBaseWire({ store: args.convStore })
  const base: Partial<ExecutionPlaneSessionDeps> = {
    conversationCheckpoint: { store: args.convStore },
    fork: { forker: forkWire.base },
    forkSession: { forker: forkWire.forker },
  }

  const subagentCfg = args.setup.sessionDeps.subagentConfig
  if (subagentCfg === undefined) return base

  const parentConfig = assembleConfig([...args.setup.history], args.setup.sessionDeps)
  const childRunner = createSubagentRunner(
    parentConfig,
    subagentCfg.maxDepth !== undefined ? { maxDepth: subagentCfg.maxDepth } : {},
  )
  const maxConcurrent = parsePositiveInt(args.envSource.QUANTA_BG_MAX_CONCURRENT)
  const maxRetained = parsePositiveInt(args.envSource.QUANTA_BG_MAX_RETAINED)
  const inner = defaultBackgroundSubagentScheduler({
    runner: childRunner,
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(maxRetained !== undefined ? { maxRetained } : {}),
  })
  const persistent = await persistentBackgroundSubagentScheduler({
    inner,
    store: defaultJsonlSchedulerStore(
      args.envSource.QUANTA_BG_STORE_DIR !== undefined
        ? { baseDir: args.envSource.QUANTA_BG_STORE_DIR }
        : undefined,
    ),
    workspace: args.setup.cwd,
  })
  const scheduler: BackgroundSubagentScheduler = {
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
    list: () =>
      persistent.list().map((entry) => ({
        ...entry,
        result: normalizeBgResult(entry.result),
      })),
    prune: (maxAgeMs) => persistent.prune(maxAgeMs),
    serialize: () => persistent.serialize(),
    hydrate: (json) => persistent.hydrate(json),
    hydrateWithPrune: (json, maxAgeMs) => persistent.hydrateWithPrune(json, maxAgeMs),
  }

  const thresholdMs = parsePositiveInt(args.envSource.QUANTA_AUTO_BACKGROUND_THRESHOLD_MS)
  const detector = defaultStuckDetector(thresholdMs !== undefined ? { thresholdMs } : {})
  const onAccept = buildSubagentForkOnAccept({ scheduler })
  const proposer = defaultProposeHandler({
    detector,
    ...(onAccept !== undefined ? { onAccept } : {}),
  })

  return {
    ...base,
    delegation: adaptDelegation(parentConfig, subagentCfg.maxDepth),
    subagentBackground: { scheduler },
    autoBackground: {
      detector,
      proposer,
      ...(thresholdMs !== undefined ? { thresholdMs } : {}),
      ...(onAccept !== undefined ? { onAccept } : {}),
    },
  }
}

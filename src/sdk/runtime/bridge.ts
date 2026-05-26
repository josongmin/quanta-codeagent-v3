import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  assembleLegacyAgentConfig,
  buildSessionDepsFromAgentConfigBase,
  type ComposeLegacySessionDepsArgs,
  composeLegacySessionDeps,
  createSingleLegacyRuntimeHost,
  type LegacyRunnerSessionHostOptions,
} from "@/host/runtime/session-host"
import type { Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"
import type { SessionMeta } from "@/session"
import { createRuntime } from "./create-runtime"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "./base"
import type { RuntimeFacade } from "./types"

export type RuntimeSessionDeps = SessionDeps

export interface RuntimeWireSummary {
  readonly executionPlane: {
    readonly conversationCheckpoint: boolean
    readonly fork: boolean
    readonly forkSession: boolean
    readonly delegation: boolean
    readonly subagentBackground: boolean
    readonly autoBackground: boolean
  }
  readonly memoryAuto: {
    readonly sessionCtx: boolean
    readonly stage1OutputsStore: boolean
    readonly memoryConsolidator: boolean
    readonly memoryConsolidatorEnabled: boolean
  }
}

export interface CreateRuntimeFromAgentConfigBaseArgs {
  readonly base: RuntimeAgentConfigBase
  readonly assembleConfig?: RuntimeAgentTurnAssembler
  readonly history?: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

export interface CreateRuntimeFacadeFromSessionDepsArgs {
  readonly boot?: {
    readonly mode: SessionBootstrapResult["mode"]
    readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
    readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
    readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
  }
  readonly sessionDeps: RuntimeSessionDeps
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

const createLegacyRuntimeFacade = async (
  args: LegacyRunnerSessionHostOptions,
): Promise<RuntimeFacade> =>
  await createRuntime({
    host: createSingleLegacyRuntimeHost(args),
  })

const createLegacyRuntimeFromAgentConfigBase = async (
  args: CreateRuntimeFromAgentConfigBaseArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly sessionDeps: SessionDeps }> => {
  const sessionDeps = buildSessionDepsFromAgentConfigBase(args.base)
  const runtime = await createLegacyRuntimeFacade({
    sessionDeps,
    ...(args.assembleConfig !== undefined ? { assembleConfig: args.assembleConfig } : {}),
    history: [...(args.history ?? args.base.messages ?? [])],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return { runtime, sessionDeps }
}

export const createRuntimeFacadeFromSessionDeps = createLegacyRuntimeFacade

export const createRuntimeFromAgentConfigBase = createLegacyRuntimeFromAgentConfigBase as (
  args: CreateRuntimeFromAgentConfigBaseArgs,
) => ReturnType<typeof createLegacyRuntimeFromAgentConfigBase>

export const composeBootstrapRuntimeDeps = composeLegacySessionDeps as (
  args: ComposeLegacySessionDepsArgs,
) => Promise<RuntimeSessionDeps>

const createLegacyRuntimeFromBootstrap = async (
  args: ComposeLegacySessionDepsArgs &
    Omit<LegacyRunnerSessionHostOptions, "sessionDeps" | "boot"> & {
      readonly boot: SessionBootstrapResult
    },
): Promise<{ readonly runtime: RuntimeFacade; readonly sessionDeps: SessionDeps }> => {
  const sessionDeps = await composeLegacySessionDeps(args)
  const runtime = await createLegacyRuntimeFacade({
    boot: {
      mode: args.boot.mode,
      refreshSystemPrompt: args.boot.refreshSystemPrompt,
      ...(args.boot.toolProfileState !== undefined
        ? { toolProfileState: args.boot.toolProfileState }
        : {}),
      ...(args.boot.identityModeState !== undefined
        ? { identityModeState: args.boot.identityModeState }
        : {}),
    },
    sessionDeps,
    ...(args.assembleConfig !== undefined ? { assembleConfig: args.assembleConfig } : {}),
    history: [...args.history],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return { runtime, sessionDeps }
}

export const createRuntimeFromBootstrap = createLegacyRuntimeFromBootstrap as (
  args: Parameters<typeof createLegacyRuntimeFromBootstrap>[0],
) => ReturnType<typeof createLegacyRuntimeFromBootstrap>

const materializeLegacyReviewerAgent = (
  boot: SessionBootstrapResult,
  baseSessionDeps: SessionDeps,
  assembleConfig?: RuntimeAgentTurnAssembler,
): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]> => {
  return boot.materializeReviewerAgent(
    assembleLegacyAgentConfig([], baseSessionDeps, assembleConfig),
  )
}

export const materializeReviewerAgent = materializeLegacyReviewerAgent as (
  boot: SessionBootstrapResult,
  baseSessionDeps: RuntimeSessionDeps,
  assembleConfig?: RuntimeAgentTurnAssembler,
) => ReturnType<typeof materializeLegacyReviewerAgent>

export const summarizeRuntimeWires = (deps: RuntimeSessionDeps): RuntimeWireSummary => ({
  executionPlane: {
    conversationCheckpoint: deps.conversationCheckpoint !== undefined,
    fork: deps.fork !== undefined,
    forkSession: deps.forkSession !== undefined,
    delegation: deps.delegation !== undefined,
    subagentBackground: deps.subagentBackground !== undefined,
    autoBackground: deps.autoBackground !== undefined,
  },
  memoryAuto: {
    sessionCtx: deps.sessionCtx !== undefined,
    stage1OutputsStore: deps.stage1OutputsStore !== undefined,
    memoryConsolidator: deps.memoryConsolidator !== undefined,
    memoryConsolidatorEnabled: deps.memoryConsolidator?.enabled === true,
  },
})

export type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler }

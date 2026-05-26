import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"
import type { SessionMeta } from "@/session"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "./base"
import {
  composeBootstrapLegacySessionDeps,
  createLegacyRuntimeFacade,
  createLegacyRuntimeFromAgentConfigBase,
  createLegacyRuntimeFromBootstrap,
  materializeLegacyReviewerAgent,
} from "./compat"

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

export const createRuntimeFacadeFromSessionDeps = createLegacyRuntimeFacade

export const createRuntimeFromAgentConfigBase = createLegacyRuntimeFromAgentConfigBase as (
  args: CreateRuntimeFromAgentConfigBaseArgs,
) => ReturnType<typeof createLegacyRuntimeFromAgentConfigBase>

export const composeBootstrapRuntimeDeps = composeBootstrapLegacySessionDeps as (
  args: Parameters<typeof composeBootstrapLegacySessionDeps>[0],
) => Promise<RuntimeSessionDeps>

export const createRuntimeFromBootstrap = createLegacyRuntimeFromBootstrap as (
  args: Parameters<typeof createLegacyRuntimeFromBootstrap>[0],
) => ReturnType<typeof createLegacyRuntimeFromBootstrap>

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

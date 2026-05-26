import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  assembleLegacyAgentConfig,
  buildSessionDepsFromAgentConfigBase,
  type ComposeLegacySessionDepsArgs,
  composeLegacySessionDeps,
  createSingleLegacyRuntimeHost,
  type LegacyRunnerSessionHostOptions,
  type LegacySessionConfigAssembler,
  type LegacySessionDepsSource,
} from "@/host/runtime/session-host"
import type { Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"
import { createRuntime, type RuntimeFacade } from "@/sdk/runtime"
import type { SessionMeta } from "@/session"

export type { LegacySessionDepsSource } from "@/host/runtime/session-host"

export interface CreateLegacyRuntimeFacadeArgs extends LegacyRunnerSessionHostOptions {}

export const createLegacyRuntimeFacade = async (
  args: CreateLegacyRuntimeFacadeArgs,
): Promise<RuntimeFacade> =>
  await createRuntime({
    host: createSingleLegacyRuntimeHost(args),
  })

export interface CreateLegacyRuntimeFromAgentConfigBaseArgs {
  readonly base: LegacySessionDepsSource
  readonly assembleConfig?: LegacySessionConfigAssembler
  readonly history?: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

export const createLegacyRuntimeFromAgentConfigBase = async (
  args: CreateLegacyRuntimeFromAgentConfigBaseArgs,
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

export interface CreateLegacyRuntimeFromBootstrapArgs
  extends ComposeLegacySessionDepsArgs,
    Omit<LegacyRunnerSessionHostOptions, "sessionDeps" | "boot"> {}

export const composeBootstrapLegacySessionDeps = async (
  args: ComposeLegacySessionDepsArgs,
): Promise<SessionDeps> => await composeLegacySessionDeps(args)

export const createLegacyRuntimeFromBootstrap = async (
  args: CreateLegacyRuntimeFromBootstrapArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly sessionDeps: SessionDeps }> => {
  const sessionDeps = await composeBootstrapLegacySessionDeps(args)
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

export const materializeLegacyReviewerAgent = (
  boot: SessionBootstrapResult,
  baseSessionDeps: SessionDeps,
  assembleConfig?: LegacySessionConfigAssembler,
): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]> => {
  return boot.materializeReviewerAgent(
    assembleLegacyAgentConfig([], baseSessionDeps, assembleConfig),
  )
}

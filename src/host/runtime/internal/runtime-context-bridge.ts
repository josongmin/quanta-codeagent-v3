import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  createRuntimeContextBindingFromAgentConfigBase,
  createRuntimeContextBindingFromBootstrap,
} from "./context-binding"
import type { Message } from "@/llm"
import type { SessionMeta } from "@/session"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "../../../sdk/runtime/base"
import { createRuntime } from "../../../sdk/runtime/create-runtime"
import type { RuntimeFacade } from "../../../sdk/runtime/types"

const RUNTIME_BRIDGE_STATE = Symbol("runtimeBridgeState")
const RAW_RUNTIME_BRIDGE_BINDING = Symbol("runtimeBridgeBinding.raw")
export const INTERNAL_TURN_ASSEMBLER_FIELD = "assembleConfig" as const

type LegacyRuntimeBridgeBinding = ReturnType<
  typeof createRuntimeContextBindingFromAgentConfigBase
>
type ComposeLegacySessionDepsArgs = Parameters<
  typeof createRuntimeContextBindingFromBootstrap
>[0]
type LegacyRuntimeBridgeSnapshot = LegacyRuntimeBridgeBinding["snapshot"]
type LegacyRuntimeBridgePatch = Parameters<LegacyRuntimeBridgeBinding["patch"]>[0]
type CreateLegacyRuntimeBridgeHostArgs = Parameters<
  LegacyRuntimeBridgeBinding["createRuntimeHost"]
>[0]

type RuntimeBridgeOptionalFields = Omit<LegacyRuntimeBridgeSnapshot, "registry" | "permission">

interface RuntimeBridgeStateRecord extends RuntimeBridgeOptionalFields {
  readonly [RUNTIME_BRIDGE_STATE]: true
  readonly [RAW_RUNTIME_BRIDGE_BINDING]: LegacyRuntimeBridgeBinding
  readonly registry: LegacyRuntimeBridgeSnapshot["registry"]
  readonly permission: LegacyRuntimeBridgeSnapshot["permission"]
}

interface RuntimeBridgeState {
  readonly [RUNTIME_BRIDGE_STATE]: true
}

export type RuntimeBridgeRegistry = RuntimeBridgeStateRecord["registry"]
export type RuntimeBridgePermissionMode = RuntimeBridgeStateRecord["permission"]["mode"]
export type RuntimeBridgeAutomationEngine = RuntimeBridgeStateRecord["automationEngine"]
export type RuntimeBridgeToolProfileState = RuntimeBridgeStateRecord["toolProfileState"]
export type RuntimeBridgeIdentityModeState = RuntimeBridgeStateRecord["identityModeState"]
export type RuntimeBridgeFocusChain = RuntimeBridgeStateRecord["focusChain"]
export type RuntimeBridgeDecisionEmitter = RuntimeBridgeStateRecord["decisionEmitter"]
export type RuntimeBridgeAdmissibility = RuntimeBridgeStateRecord["admissibility"]
export type RuntimeBridgePlanExitPort = RuntimeBridgeStateRecord["planExitPort"]
export type RuntimeBridgeUserInputPort = RuntimeBridgeStateRecord["userInputPort"]
export type RuntimeBridgeGranularRegistry = RuntimeBridgeStateRecord["granularRegistry"]

type RuntimeBridgeStatePatch = Partial<
  Pick<
    RuntimeBridgeStateRecord,
    | "registry"
    | "systemSource"
    | "automationEngine"
    | "toolProfileState"
    | "identityModeState"
    | "focusChain"
    | "decisionEmitter"
    | "admissibility"
    | "planExitPort"
    | "userInputPort"
    | "conversationCheckpoint"
    | "fork"
    | "forkSession"
    | "delegation"
    | "subagentBackground"
    | "autoBackground"
    | "sessionCtx"
    | "stage1OutputsStore"
    | "memoryConsolidator"
    | "granularRegistry"
  >
>

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

export interface CreateRuntimeFacadeFromBridgeStateArgs {
  readonly boot?: {
    readonly mode: SessionBootstrapResult["mode"]
    readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
    readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
    readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
  }
  readonly bridgeState: RuntimeBridgeState
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

const whenDefined = <K extends keyof RuntimeBridgeOptionalFields>(
  key: K,
  value: RuntimeBridgeOptionalFields[K] | undefined,
): Partial<RuntimeBridgeOptionalFields> =>
  value === undefined ? {} : ({ [key]: value } as Partial<RuntimeBridgeOptionalFields>)

const buildOptionalRuntimeBridgeFields = (
  snapshot: LegacyRuntimeBridgeSnapshot,
): Partial<RuntimeBridgeOptionalFields> => ({
  ...whenDefined("systemSource", snapshot.systemSource),
  ...whenDefined("automationEngine", snapshot.automationEngine),
  ...whenDefined("toolProfileState", snapshot.toolProfileState),
  ...whenDefined("identityModeState", snapshot.identityModeState),
  ...whenDefined("focusChain", snapshot.focusChain),
  ...whenDefined("decisionEmitter", snapshot.decisionEmitter),
  ...whenDefined("admissibility", snapshot.admissibility),
  ...whenDefined("planExitPort", snapshot.planExitPort),
  ...whenDefined("userInputPort", snapshot.userInputPort),
  ...whenDefined("conversationCheckpoint", snapshot.conversationCheckpoint),
  ...whenDefined("fork", snapshot.fork),
  ...whenDefined("forkSession", snapshot.forkSession),
  ...whenDefined("delegation", snapshot.delegation),
  ...whenDefined("subagentBackground", snapshot.subagentBackground),
  ...whenDefined("autoBackground", snapshot.autoBackground),
  ...whenDefined("sessionCtx", snapshot.sessionCtx),
  ...whenDefined("stage1OutputsStore", snapshot.stage1OutputsStore),
  ...whenDefined("memoryConsolidator", snapshot.memoryConsolidator),
  ...whenDefined("granularRegistry", snapshot.granularRegistry),
})

const isRuntimeBridgeBinding = (value: unknown): value is LegacyRuntimeBridgeBinding =>
  typeof value === "object" &&
  value !== null &&
  "snapshot" in value &&
  "patch" in value &&
  "createRuntimeHost" in value &&
  "materializeReviewerAgent" in value

const toRuntimeBridgeStateRecord = (state: RuntimeBridgeState): RuntimeBridgeStateRecord => {
  const record = state as RuntimeBridgeStateRecord
  if (record[RAW_RUNTIME_BRIDGE_BINDING] !== undefined) return record
  if (isRuntimeBridgeBinding(state)) {
    return {
      [RUNTIME_BRIDGE_STATE]: true,
      [RAW_RUNTIME_BRIDGE_BINDING]: state,
      registry: state.snapshot.registry,
      permission: state.snapshot.permission,
      ...buildOptionalRuntimeBridgeFields(state.snapshot),
    }
  }
  return record
}

const wrapRuntimeBridgeState = (binding: LegacyRuntimeBridgeBinding): RuntimeBridgeStateRecord => ({
  [RUNTIME_BRIDGE_STATE]: true,
  [RAW_RUNTIME_BRIDGE_BINDING]: binding,
  registry: binding.snapshot.registry,
  permission: binding.snapshot.permission,
  ...buildOptionalRuntimeBridgeFields(binding.snapshot),
})

const unwrapRuntimeBridgeState = (state: RuntimeBridgeState): LegacyRuntimeBridgeBinding =>
  toRuntimeBridgeStateRecord(state)[RAW_RUNTIME_BRIDGE_BINDING]

export const patchRuntimeBridgeState = (
  state: RuntimeBridgeState,
  patch: RuntimeBridgeStatePatch,
): RuntimeBridgeState =>
  wrapRuntimeBridgeState(unwrapRuntimeBridgeState(state).patch(patch as LegacyRuntimeBridgePatch))

export const getRuntimeBridgeRegistry = (state: RuntimeBridgeState): RuntimeBridgeRegistry =>
  toRuntimeBridgeStateRecord(state).registry

export const getRuntimeBridgePermissionMode = (
  state: RuntimeBridgeState,
): RuntimeBridgePermissionMode => toRuntimeBridgeStateRecord(state).permission.mode

export const getRuntimeBridgeAutomationEngine = (
  state: RuntimeBridgeState,
): RuntimeBridgeAutomationEngine => toRuntimeBridgeStateRecord(state).automationEngine

export const getRuntimeBridgeToolProfileState = (
  state: RuntimeBridgeState,
): RuntimeBridgeToolProfileState => toRuntimeBridgeStateRecord(state).toolProfileState

export const getRuntimeBridgeIdentityModeState = (
  state: RuntimeBridgeState,
): RuntimeBridgeIdentityModeState => toRuntimeBridgeStateRecord(state).identityModeState

export const getRuntimeBridgeFocusChain = (state: RuntimeBridgeState): RuntimeBridgeFocusChain =>
  toRuntimeBridgeStateRecord(state).focusChain

export const getRuntimeBridgeDecisionEmitter = (
  state: RuntimeBridgeState,
): RuntimeBridgeDecisionEmitter => toRuntimeBridgeStateRecord(state).decisionEmitter

export const getRuntimeBridgeAdmissibility = (
  state: RuntimeBridgeState,
): RuntimeBridgeAdmissibility => toRuntimeBridgeStateRecord(state).admissibility

export const getRuntimeBridgePlanExitPort = (
  state: RuntimeBridgeState,
): RuntimeBridgePlanExitPort => toRuntimeBridgeStateRecord(state).planExitPort

export const getRuntimeBridgeUserInputPort = (
  state: RuntimeBridgeState,
): RuntimeBridgeUserInputPort => toRuntimeBridgeStateRecord(state).userInputPort

const createLegacyRuntimeFacade = async (
  binding: LegacyRuntimeBridgeBinding,
  args: CreateLegacyRuntimeBridgeHostArgs,
): Promise<RuntimeFacade> =>
  await createRuntime({
    host: binding.createRuntimeHost(args),
  })

const createLegacyRuntimeFromAgentConfigBase = async (
  args: CreateRuntimeFromAgentConfigBaseArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly bridgeState: RuntimeBridgeState }> => {
  const binding = createRuntimeContextBindingFromAgentConfigBase({
    base: args.base,
    ...(args.assembleConfig !== undefined ? { assembleConfig: args.assembleConfig } : {}),
  })
  const runtime = await createLegacyRuntimeFacade(binding, {
    history: [...(args.history ?? args.base.messages ?? [])],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return { runtime, bridgeState: wrapRuntimeBridgeState(binding) }
}

export const createRuntimeFacadeFromBridgeState = async (
  args: CreateRuntimeFacadeFromBridgeStateArgs,
): Promise<RuntimeFacade> =>
  await createLegacyRuntimeFacade(unwrapRuntimeBridgeState(args.bridgeState), {
    ...(args.boot !== undefined ? { boot: args.boot } : {}),
    history: args.history,
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })

export const createRuntimeFromAgentConfigBase = createLegacyRuntimeFromAgentConfigBase as (
  args: CreateRuntimeFromAgentConfigBaseArgs,
) => ReturnType<typeof createLegacyRuntimeFromAgentConfigBase>

export const composeBootstrapRuntimeDeps = async (
  args: ComposeLegacySessionDepsArgs,
): Promise<RuntimeBridgeState> =>
  wrapRuntimeBridgeState(await createRuntimeContextBindingFromBootstrap(args))

const createLegacyRuntimeFromBootstrap = async (
  args: ComposeLegacySessionDepsArgs &
    Omit<CreateLegacyRuntimeBridgeHostArgs, "boot"> & {
      readonly boot: SessionBootstrapResult
      readonly assembleConfig?: RuntimeAgentTurnAssembler
    },
): Promise<{ readonly runtime: RuntimeFacade; readonly bridgeState: RuntimeBridgeState }> => {
  const binding = await createRuntimeContextBindingFromBootstrap({
    ...args,
    ...(args.assembleConfig !== undefined ? { assembleConfig: args.assembleConfig } : {}),
  })
  const runtime = await createLegacyRuntimeFacade(binding, {
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
    history: [...args.history],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return { runtime, bridgeState: wrapRuntimeBridgeState(binding) }
}

export const createRuntimeFromBootstrap = createLegacyRuntimeFromBootstrap as (
  args: Parameters<typeof createLegacyRuntimeFromBootstrap>[0],
) => ReturnType<typeof createLegacyRuntimeFromBootstrap>

const materializeLegacyReviewerAgent = (
  boot: SessionBootstrapResult,
  baseBridgeState: RuntimeBridgeState,
  assembleConfig?: RuntimeAgentTurnAssembler,
): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]> => {
  return unwrapRuntimeBridgeState(baseBridgeState).materializeReviewerAgent(boot, assembleConfig)
}

export const materializeReviewerAgent = materializeLegacyReviewerAgent as (
  boot: SessionBootstrapResult,
  baseBridgeState: RuntimeBridgeState,
  assembleConfig?: RuntimeAgentTurnAssembler,
) => ReturnType<typeof materializeLegacyReviewerAgent>

export const summarizeRuntimeWires = (state: RuntimeBridgeState): RuntimeWireSummary => {
  const deps = toRuntimeBridgeStateRecord(state)
  return {
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
  }
}

export type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler }

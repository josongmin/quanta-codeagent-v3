import type { GranularRegistryPort } from "@/agent/checkpoint/granular-registry"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  INTERNAL_TURN_ASSEMBLER_FIELD,
  composeBootstrapRuntimeDeps as composeBootstrapRuntimeDepsInternal,
  createRuntimeFacadeFromBridgeState as createRuntimeFacadeFromBridgeStateInternal,
  createRuntimeFromAgentConfigBase as createRuntimeFromAgentConfigBaseInternal,
  createRuntimeFromBootstrap as createRuntimeFromBootstrapInternal,
  getRuntimeBridgeAdmissibility,
  getRuntimeBridgeAutomationEngine,
  getRuntimeBridgeDecisionEmitter,
  getRuntimeBridgeFocusChain,
  getRuntimeBridgeIdentityModeState,
  getRuntimeBridgePermissionMode,
  getRuntimeBridgePlanExitPort,
  getRuntimeBridgeRegistry,
  getRuntimeBridgeToolProfileState,
  getRuntimeBridgeUserInputPort,
  materializeReviewerAgent as materializeReviewerAgentInternal,
  patchRuntimeBridgeState,
  summarizeRuntimeWires as summarizeRuntimeWiresInternal,
} from "@/host/runtime/internal/runtime-context-bridge"
import type { Tool } from "@/tool"
import { automationUpdateTool, ToolRegistry } from "@/tool"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "./base"
import type { RuntimeFacade } from "./types"

type InternalRuntimeContextState = Awaited<ReturnType<typeof composeBootstrapRuntimeDepsInternal>>
type RuntimeContextRegistryView = ReturnType<typeof getRuntimeBridgeRegistry>
type RuntimeContextPermissionModeView = ReturnType<typeof getRuntimeBridgePermissionMode>
type RuntimeContextAutomationEngineView = ReturnType<typeof getRuntimeBridgeAutomationEngine>
type RuntimeContextToolProfileStateView = ReturnType<typeof getRuntimeBridgeToolProfileState>
type RuntimeContextIdentityModeStateView = ReturnType<typeof getRuntimeBridgeIdentityModeState>
type RuntimeContextFocusChainView = ReturnType<typeof getRuntimeBridgeFocusChain>
type RuntimeContextDecisionEmitterView = ReturnType<typeof getRuntimeBridgeDecisionEmitter>
type RuntimeContextAdmissibilityView = ReturnType<typeof getRuntimeBridgeAdmissibility>
type RuntimeContextPlanExitPortView = ReturnType<typeof getRuntimeBridgePlanExitPort>
type RuntimeContextUserInputPortView = ReturnType<typeof getRuntimeBridgeUserInputPort>
type CreateRuntimeFacadeArgs = Omit<
  Parameters<typeof createRuntimeFacadeFromBridgeStateInternal>[0],
  "bridgeState"
>
type InternalFromBaseArgs = Parameters<typeof createRuntimeFromAgentConfigBaseInternal>[0]
type InternalFromBootstrapArgs = Parameters<typeof createRuntimeFromBootstrapInternal>[0]
type InternalBootstrapContextArgs = Parameters<typeof composeBootstrapRuntimeDepsInternal>[0]

type TurnAssemblerPatch = Partial<
  Record<typeof INTERNAL_TURN_ASSEMBLER_FIELD, RuntimeAgentTurnAssembler>
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

export interface RuntimeContext {
  createRuntimeFacade(args: CreateRuntimeFacadeArgs): Promise<RuntimeFacade>
  registry(): RuntimeContextRegistryView
  wrapRegistry(mapper: (tool: Tool) => Tool): void
  permissionMode(): RuntimeContextPermissionModeView
  automationEngine(): RuntimeContextAutomationEngineView
  ensureAutomationEngine(
    slot: NonNullable<RuntimeContextAutomationEngineView>,
  ): RuntimeContextAutomationEngineView
  setGranularRegistry(registry: GranularRegistryPort): void
  toolProfileState(): RuntimeContextToolProfileStateView
  identityModeState(): RuntimeContextIdentityModeStateView
  focusChain(): RuntimeContextFocusChainView
  decisionEmitter(): RuntimeContextDecisionEmitterView
  admissibility(): RuntimeContextAdmissibilityView
  withAdmissibility(admissibility: NonNullable<RuntimeContextAdmissibilityView>): void
  planExitPort(): RuntimeContextPlanExitPortView
  userInputPort(): RuntimeContextUserInputPortView
}

interface RuntimeContextRecord extends RuntimeContext {
  state: InternalRuntimeContextState
}

export interface CreateRuntimeFromAgentConfigBaseArgs
  extends Omit<InternalFromBaseArgs, typeof INTERNAL_TURN_ASSEMBLER_FIELD> {
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface ComposeRuntimeBootstrapContextArgs
  extends Omit<InternalBootstrapContextArgs, typeof INTERNAL_TURN_ASSEMBLER_FIELD> {
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface CreateRuntimeFromBootstrapArgs
  extends Omit<InternalFromBootstrapArgs, typeof INTERNAL_TURN_ASSEMBLER_FIELD> {
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

const withTurnAssembler = <T extends object>(
  args: T,
  turnAssembler: RuntimeAgentTurnAssembler | undefined,
): T & TurnAssemblerPatch =>
  turnAssembler === undefined
    ? (args as T & TurnAssemblerPatch)
    : ({
        ...args,
        [INTERNAL_TURN_ASSEMBLER_FIELD]: turnAssembler,
      } as T & TurnAssemblerPatch)

const unwrapRuntimeContext = (context: RuntimeContext): RuntimeContextRecord =>
  context as RuntimeContextRecord

const createRuntimeContext = (initialState: InternalRuntimeContextState): RuntimeContext => {
  const record: RuntimeContextRecord = {
    state: initialState,
    createRuntimeFacade: async (args) =>
      await createRuntimeFacadeFromBridgeStateInternal({
        ...args,
        bridgeState: record.state,
      }),
    registry: () => getRuntimeBridgeRegistry(record.state),
    wrapRegistry: (mapper) => {
      const registry = getRuntimeBridgeRegistry(record.state)
      record.state = patchRuntimeBridgeState(record.state, {
        registry: new ToolRegistry(registry.all().map((tool) => mapper(tool))),
      }) as InternalRuntimeContextState
    },
    permissionMode: () => getRuntimeBridgePermissionMode(record.state),
    automationEngine: () => getRuntimeBridgeAutomationEngine(record.state),
    ensureAutomationEngine: (slot) => {
      const registry = getRuntimeBridgeRegistry(record.state)
      record.state = patchRuntimeBridgeState(record.state, {
        automationEngine: slot,
        registry: registry.has("automation_update")
          ? registry
          : new ToolRegistry([...registry.all(), automationUpdateTool(slot.engine)]),
      }) as InternalRuntimeContextState
      return getRuntimeBridgeAutomationEngine(record.state)
    },
    setGranularRegistry: (registry) => {
      record.state = patchRuntimeBridgeState(record.state, {
        granularRegistry: registry,
      }) as InternalRuntimeContextState
    },
    toolProfileState: () => getRuntimeBridgeToolProfileState(record.state),
    identityModeState: () => getRuntimeBridgeIdentityModeState(record.state),
    focusChain: () => getRuntimeBridgeFocusChain(record.state),
    decisionEmitter: () => getRuntimeBridgeDecisionEmitter(record.state),
    admissibility: () => getRuntimeBridgeAdmissibility(record.state),
    withAdmissibility: (admissibility) => {
      record.state = patchRuntimeBridgeState(record.state, {
        admissibility,
      }) as InternalRuntimeContextState
    },
    planExitPort: () => getRuntimeBridgePlanExitPort(record.state),
    userInputPort: () => getRuntimeBridgeUserInputPort(record.state),
  }
  return record
}

export const createRuntimeFromAgentConfigBase = async (
  args: CreateRuntimeFromAgentConfigBaseArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly runtimeContext: RuntimeContext }> => {
  const result = await createRuntimeFromAgentConfigBaseInternal(
    withTurnAssembler(
      {
        base: args.base,
        ...(args.history !== undefined ? { history: args.history } : {}),
        state: args.state,
        idMeta: args.idMeta,
        shutdown: args.shutdown,
        ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
      },
      args.turnAssembler,
    ) as InternalFromBaseArgs,
  )
  return {
    runtime: result.runtime,
    runtimeContext: createRuntimeContext(result.bridgeState),
  }
}

export const composeRuntimeBootstrapContext = async (
  args: ComposeRuntimeBootstrapContextArgs,
): Promise<RuntimeContext> =>
  createRuntimeContext(
    await composeBootstrapRuntimeDepsInternal(
      withTurnAssembler(
        {
          boot: args.boot,
          stream: args.stream,
          onConfirm: args.onConfirm,
          ...(args.includeSearchPipeline !== undefined
            ? { includeSearchPipeline: args.includeSearchPipeline }
            : {}),
          ...(args.overlay !== undefined ? { overlay: args.overlay } : {}),
          ...(args.execution !== undefined ? { execution: args.execution } : {}),
          ...(args.memoryAuto !== undefined ? { memoryAuto: args.memoryAuto } : {}),
        },
        args.turnAssembler,
      ) as InternalBootstrapContextArgs,
    ),
  )

export const createRuntimeFromBootstrap = async (
  args: CreateRuntimeFromBootstrapArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly runtimeContext: RuntimeContext }> => {
  const result = await createRuntimeFromBootstrapInternal(
    withTurnAssembler(
      {
        boot: args.boot,
        stream: args.stream,
        onConfirm: args.onConfirm,
        ...(args.includeSearchPipeline !== undefined
          ? { includeSearchPipeline: args.includeSearchPipeline }
          : {}),
        ...(args.overlay !== undefined ? { overlay: args.overlay } : {}),
        ...(args.execution !== undefined ? { execution: args.execution } : {}),
        ...(args.memoryAuto !== undefined ? { memoryAuto: args.memoryAuto } : {}),
        history: args.history,
        state: args.state,
        idMeta: args.idMeta,
        shutdown: args.shutdown,
        ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
      },
      args.turnAssembler,
    ) as InternalFromBootstrapArgs,
  )
  return {
    runtime: result.runtime,
    runtimeContext: createRuntimeContext(result.bridgeState),
  }
}

export const materializeReviewerAgent = (
  boot: SessionBootstrapResult,
  runtimeContext: RuntimeContext,
  turnAssembler?: RuntimeAgentTurnAssembler,
): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]> =>
  materializeReviewerAgentInternal(
    boot,
    unwrapRuntimeContext(runtimeContext).state,
    turnAssembler,
  )

export const summarizeRuntimeContext = (runtimeContext: RuntimeContext): RuntimeWireSummary =>
  summarizeRuntimeWiresInternal(unwrapRuntimeContext(runtimeContext).state)

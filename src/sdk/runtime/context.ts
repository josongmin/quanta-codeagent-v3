import type { GranularRegistryPort } from "@/agent/checkpoint/granular-registry"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  createRuntimeContextBindingFromAgentConfigBase,
  createRuntimeContextBindingFromBootstrap,
} from "@/host/runtime/internal/context-binding"
import type { Tool } from "@/tool"
import { automationUpdateTool, ToolRegistry } from "@/tool"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "./base"
import { createRuntime } from "./create-runtime"
import type { RuntimeFacade } from "./types"

type RuntimeContextBinding = ReturnType<typeof createRuntimeContextBindingFromAgentConfigBase>
type RuntimeContextSnapshot = RuntimeContextBinding["snapshot"]
type InternalRuntimeContextState = RuntimeContextBinding
type RuntimeContextRegistryView = RuntimeContextSnapshot["registry"]
type RuntimeContextPermissionModeView = RuntimeContextSnapshot["permission"]["mode"]
type RuntimeContextAutomationEngineView = RuntimeContextSnapshot["automationEngine"]
type RuntimeContextToolProfileStateView = RuntimeContextSnapshot["toolProfileState"]
type RuntimeContextIdentityModeStateView = RuntimeContextSnapshot["identityModeState"]
type RuntimeContextFocusChainView = RuntimeContextSnapshot["focusChain"]
type RuntimeContextDecisionEmitterView = RuntimeContextSnapshot["decisionEmitter"]
type RuntimeContextAdmissibilityView = RuntimeContextSnapshot["admissibility"]
type RuntimeContextPlanExitPortView = RuntimeContextSnapshot["planExitPort"]
type RuntimeContextUserInputPortView = RuntimeContextSnapshot["userInputPort"]
type CreateRuntimeFacadeArgs = Parameters<RuntimeContextBinding["createRuntimeHost"]>[0]
type RuntimeContextPatch = Parameters<RuntimeContextBinding["patch"]>[0]
type InternalBootstrapContextArgs = Parameters<typeof createRuntimeContextBindingFromBootstrap>[0]
type RuntimeCreateHostArgs = Omit<CreateRuntimeFacadeArgs, "boot">

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
  extends Omit<RuntimeCreateHostArgs, "history"> {
  readonly base: RuntimeAgentConfigBase
  readonly history?: CreateRuntimeFacadeArgs["history"]
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface ComposeRuntimeBootstrapContextArgs
  extends Omit<InternalBootstrapContextArgs, "turnAssembler"> {
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface CreateRuntimeFromBootstrapArgs
  extends ComposeRuntimeBootstrapContextArgs,
    RuntimeCreateHostArgs {}

const createRuntimeFacadeFromBinding = async (
  binding: RuntimeContextBinding,
  args: CreateRuntimeFacadeArgs,
): Promise<RuntimeFacade> =>
  await createRuntime({
    host: binding.createRuntimeHost(args),
  })

const unwrapRuntimeContext = (context: RuntimeContext): RuntimeContextRecord =>
  context as RuntimeContextRecord

const patchRuntimeContextState = (
  state: InternalRuntimeContextState,
  patch: RuntimeContextPatch,
): InternalRuntimeContextState => state.patch(patch)

const summarizeRuntimeSnapshot = (snapshot: RuntimeContextSnapshot): RuntimeWireSummary => ({
  executionPlane: {
    conversationCheckpoint: snapshot.conversationCheckpoint !== undefined,
    fork: snapshot.fork !== undefined,
    forkSession: snapshot.forkSession !== undefined,
    delegation: snapshot.delegation !== undefined,
    subagentBackground: snapshot.subagentBackground !== undefined,
    autoBackground: snapshot.autoBackground !== undefined,
  },
  memoryAuto: {
    sessionCtx: snapshot.sessionCtx !== undefined,
    stage1OutputsStore: snapshot.stage1OutputsStore !== undefined,
    memoryConsolidator: snapshot.memoryConsolidator !== undefined,
    memoryConsolidatorEnabled: snapshot.memoryConsolidator?.enabled === true,
  },
})

const runtimeBootBindings = (
  boot: SessionBootstrapResult,
): NonNullable<CreateRuntimeFacadeArgs["boot"]> => ({
  mode: boot.mode,
  refreshSystemPrompt: boot.refreshSystemPrompt,
  ...(boot.toolProfileState !== undefined ? { toolProfileState: boot.toolProfileState } : {}),
  ...(boot.identityModeState !== undefined ? { identityModeState: boot.identityModeState } : {}),
})

const createRuntimeContext = (initialState: InternalRuntimeContextState): RuntimeContext => {
  const record: RuntimeContextRecord = {
    state: initialState,
    createRuntimeFacade: async (args) => await createRuntimeFacadeFromBinding(record.state, args),
    registry: () => record.state.snapshot.registry,
    wrapRegistry: (mapper) => {
      const registry = record.state.snapshot.registry
      record.state = patchRuntimeContextState(record.state, {
        registry: new ToolRegistry(registry.all().map((tool) => mapper(tool))),
      })
    },
    permissionMode: () => record.state.snapshot.permission.mode,
    automationEngine: () => record.state.snapshot.automationEngine,
    ensureAutomationEngine: (slot) => {
      const registry = record.state.snapshot.registry
      record.state = patchRuntimeContextState(record.state, {
        automationEngine: slot,
        registry: registry.has("automation_update")
          ? registry
          : new ToolRegistry([...registry.all(), automationUpdateTool(slot.engine)]),
      })
      return record.state.snapshot.automationEngine
    },
    setGranularRegistry: (registry) => {
      record.state = patchRuntimeContextState(record.state, {
        granularRegistry: registry,
      })
    },
    toolProfileState: () => record.state.snapshot.toolProfileState,
    identityModeState: () => record.state.snapshot.identityModeState,
    focusChain: () => record.state.snapshot.focusChain,
    decisionEmitter: () => record.state.snapshot.decisionEmitter,
    admissibility: () => record.state.snapshot.admissibility,
    withAdmissibility: (admissibility) => {
      record.state = patchRuntimeContextState(record.state, {
        admissibility,
      })
    },
    planExitPort: () => record.state.snapshot.planExitPort,
    userInputPort: () => record.state.snapshot.userInputPort,
  }
  return record
}

export const createRuntimeFromAgentConfigBase = async (
  args: CreateRuntimeFromAgentConfigBaseArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly runtimeContext: RuntimeContext }> => {
  const binding = createRuntimeContextBindingFromAgentConfigBase({
    base: args.base,
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
  const runtime = await createRuntimeFacadeFromBinding(binding, {
    history: [...(args.history ?? args.base.messages ?? [])],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return {
    runtime,
    runtimeContext: createRuntimeContext(binding),
  }
}

export const composeRuntimeBootstrapContext = async (
  args: ComposeRuntimeBootstrapContextArgs,
): Promise<RuntimeContext> =>
  createRuntimeContext(await createRuntimeContextBindingFromBootstrap(args))

export const createRuntimeFromBootstrap = async (
  args: CreateRuntimeFromBootstrapArgs,
): Promise<{ readonly runtime: RuntimeFacade; readonly runtimeContext: RuntimeContext }> => {
  const binding = await createRuntimeContextBindingFromBootstrap({
    boot: args.boot,
    stream: args.stream,
    onConfirm: args.onConfirm,
    ...(args.includeSearchPipeline !== undefined
      ? { includeSearchPipeline: args.includeSearchPipeline }
      : {}),
    ...(args.overlay !== undefined ? { overlay: args.overlay } : {}),
    ...(args.execution !== undefined ? { execution: args.execution } : {}),
    ...(args.memoryAuto !== undefined ? { memoryAuto: args.memoryAuto } : {}),
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
  const runtime = await createRuntimeFacadeFromBinding(binding, {
    boot: runtimeBootBindings(args.boot),
    history: [...args.history],
    state: args.state,
    idMeta: args.idMeta,
    shutdown: args.shutdown,
    ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
  })
  return {
    runtime,
    runtimeContext: createRuntimeContext(binding),
  }
}

export const materializeReviewerAgent = (
  boot: SessionBootstrapResult,
  runtimeContext: RuntimeContext,
  turnAssembler?: RuntimeAgentTurnAssembler,
): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]> =>
  unwrapRuntimeContext(runtimeContext).state.materializeReviewerAgent(boot, turnAssembler)

export const summarizeRuntimeContext = (runtimeContext: RuntimeContext): RuntimeWireSummary =>
  summarizeRuntimeSnapshot(unwrapRuntimeContext(runtimeContext).state.snapshot)

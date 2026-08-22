import type { AgentConfig } from "@/agent"
import type { ObjectivePort } from "@/objective"
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
type RuntimeContextPermissionModeStateView = RuntimeContextSnapshot["permissionModeState"]
type RuntimeContextFocusChainView = RuntimeContextSnapshot["focusChain"]
type RuntimeContextStickyModelStoreView = RuntimeContextSnapshot["stickyModelStore"]
type RuntimeContextDecisionEmitterView = RuntimeContextSnapshot["decisionEmitter"]
type RuntimeContextAdmissibilityView = RuntimeContextSnapshot["admissibility"]
type RuntimeContextPlanExitPortView = RuntimeContextSnapshot["planExitPort"]
type RuntimeContextUserInputPortView = RuntimeContextSnapshot["userInputPort"]
type RuntimeContextDreamTriggerView = RuntimeContextSnapshot["dreamTrigger"]
type InternalCreateRuntimeFacadeArgs = Parameters<RuntimeContextBinding["createRuntimeHost"]>[0]
type RuntimeContextPatch = Parameters<RuntimeContextBinding["patch"]>[0]
type InternalBootstrapContextArgs = Parameters<typeof createRuntimeContextBindingFromBootstrap>[0]
type RuntimeCreateHostArgs = Omit<CreateRuntimeFacadeArgs, "boot" | "compose">

export interface RuntimeFacadeComposeOptions {
  readonly automationEngine?: NonNullable<RuntimeContextAutomationEngineView>
  readonly registryToolMapper?: (tool: Tool) => Tool
  /** Per-turn prompt-assembled sink. When set, it
   *  is patched onto the runtime context state so the built `AgentConfig` carries
   *  `onPromptAssembled` and the loop fires it each turn (REPL `/context` live
   *  breakdown). Absent ⇒ slot omitted ⇒ `AgentConfig.onPromptAssembled`
   *  undefined ⇒ loop byte-identical. */
  readonly onPromptAssembled?: AgentConfig["onPromptAssembled"]
  /** Working-state feature gate (`/state`). When `enabled === true` the loop
   *  builds the session-scoped WorkingState + registers `update_working_state`.
   *  Absent ⇒ feature OFF (byte-identical). */
  readonly workingState?: AgentConfig["workingState"]
  /** Publisher the loop fires once with a live working-state snapshot getter
   *  (mirrors `onPromptAssembled`). The surface retains it for `/state`. */
  readonly onWorkingStateReady?: AgentConfig["onWorkingStateReady"]
  /** ADR-0512 P3 — publisher the loop fires once with a live skill-scope getter
   *  (mirrors `onWorkingStateReady`). The surface retains it so `/state` can show
   *  the active skill's visible/hidden tool partition. Fired only under
   *  `skillScopeV2`. */
  readonly onSkillScopeReady?: AgentConfig["onSkillScopeReady"]
  /** Per-turn stream-input capture sink. The surface retains the latest so
   *  `/retry-with` can re-stream the last turn against an alternate model. */
  readonly onTurnStreamInput?: AgentConfig["onTurnStreamInput"]
  /** Shadow object-DB for `/snapshot` browse/restore/diff + branch-search
   *  anchors. Absent ⇒ `/snapshot` prints "shadow store not configured". */
  readonly shadowOdb?: AgentConfig["shadowOdb"]
  /** Auto-checkpoint policy — anchors workspace snapshots into `shadowOdb`
   *  around tool calls so `/snapshot` has restore points to browse. */
  readonly shadowCheckpoint?: AgentConfig["shadowCheckpoint"]
  /** Pre-compaction HITL hook. When set, the loop awaits this before folding
   *  history; the CLI maps it to the interactive approval prompt. */
  readonly onPreCompact?: AgentConfig["onPreCompact"]
  /** Image-sanitization retry wrapper. When enabled, the loop wraps `llm` to
   *  retry image-bearing turns with a placeholder if the provider rejects. */
  readonly imageSanitizationRetry?: AgentConfig["imageSanitizationRetry"]
  /** Per-turn git turn-diff capture. When enabled, the loop builds a
   *  TurnDiffSession and emits `turn_diff_updated` events the CLI renders. */
  readonly gitObservability?: AgentConfig["gitObservability"]
  /** ADR-0071 mid-turn typed control port. When set, the loop polls it once
   *  per turn at the top of the body. MUST be paired with `activeTurnRef`
   *  (the loop errors otherwise). Absent ⇒ loop never polls (byte-identical). */
  readonly conversationActionPort?: AgentConfig["conversationActionPort"]
  /** ADR-0071 — the `{ current: ActiveTurnState }` holder the loop overwrites
   *  each turn boundary. Required companion of `conversationActionPort`. */
  readonly activeTurnRef?: AgentConfig["activeTurnRef"]
  /** ADR-0400 shadow-verify port. When set, the loop registers the
   *  `shadow_verify` LLM tool (CLI parity with the web surface). */
  readonly shadowVerify?: AgentConfig["shadowVerify"]
  /** ADR-0231 (wire phase) — radar proposal-queue producer block. When set
   *  (the composition root mints it behind `QUANTA_RADAR`), the built
   *  `AgentConfig.radar` carries it and the loop deposits a heuristic card at
   *  each COMPLETED turn boundary. Absent ⇒ slot omitted ⇒ no sampling
   *  (byte-identical). */
  readonly radar?: AgentConfig["radar"]
  /** S1 (jul-04) `/browser-net` — the surface-owned network-capture holder. The
   *  CLI mints ONE `BrowserNetHolder` and threads it DOWN here (mirrors the
   *  `automationEngine` slot). It rides the runtime-context snapshot → the
   *  per-turn base → `maybeWireBrowser`, which attaches it to
   *  `config.browser.netHolder` so a `browser_network` drain mirrors its
   *  METADATA-ONLY rows into the SAME holder the `/browser-net` slash reads
   *  (single-instance, no split-brain). Absent ⇒ no mirror (byte-identical).
   *  Structurally typed (`{ set }`) so this SDK layer imports no CLI/tool value. */
  readonly browserNet?: RuntimeComposeBrowserNetSink
  /** `/goal` (Codex parity) — the surface-owned objective store. The CLI mints
   *  ONE store, backs the `/goal` slash + idle continuation ticker + status chip
   *  with it, and threads it DOWN here so `maybeWireObjective` adopts it as
   *  caller-override — the LLM `objective_*` tools then mutate the SAME store, so
   *  the agent marking the goal complete stops the pursuit. Absent ⇒ the
   *  assembler mints its own (byte-identical). */
  readonly objective?: ObjectivePort
  /** §9.6 `/presets` (opusplan parity) — the role→model resolver the surface
   *  built by wrapping its SINGLE `StickyPresetResolver`
   *  (`buildPresetRoleModelResolver(ctx.presets)`). Threaded DOWN here (mirrors
   *  `objective`) so it lands on `AgentConfig.roleModelResolver` and
   *  `resolveChildLlm` consults it for a delegated role's model. Absent ⇒ slot
   *  omitted ⇒ `wireOptionalAgentPorts` defaults the SSOT resolver (which returns
   *  the caller fallback verbatim), byte-identical to the no-preset path. */
  readonly roleModelResolver?: AgentConfig["roleModelResolver"]
}

/** S1 (jul-04) — the write-only net-capture sink the CLI threads through
 *  {@link RuntimeFacadeComposeOptions.browserNet}. Structural mirror of
 *  `@/tool/browser`'s `BrowserNetSink` (kept local so the SDK runtime layer does
 *  not depend on the tool slice). */
export interface RuntimeComposeBrowserNetSink {
  set(snapshot: { readonly rows: readonly unknown[]; readonly at: number }): void
}

export interface CreateRuntimeFacadeArgs extends InternalCreateRuntimeFacadeArgs {
  readonly compose?: RuntimeFacadeComposeOptions
}

export interface RuntimeWireSummary {
  readonly executionPlane: {
    readonly conversationCheckpoint: boolean
    readonly responsesContinuation: boolean
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
  materializeReviewerAgent(
    boot: SessionBootstrapResult,
    turnAssembler?: RuntimeAgentTurnAssembler,
  ): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]>
  registry(): RuntimeContextRegistryView
  permissionMode(): RuntimeContextPermissionModeView
  /** ADR-0303 — the engine-owned mutable permission posture (when the host
   *  wired one). A surface mutates it (`.set()`) and the NEXT turn's
   *  admissibility gate reads the new mode live, unlike `permissionMode()`
   *  which is the scalar snapshot read once at session creation. */
  permissionModeState(): RuntimeContextPermissionModeStateView
  automationEngine(): RuntimeContextAutomationEngineView
  toolProfileState(): RuntimeContextToolProfileStateView
  identityModeState(): RuntimeContextIdentityModeStateView
  focusChain(): RuntimeContextFocusChainView
  /** ADR-0462 — the per-mode sticky-model store, present iff the host wired one
   *  (`--sticky-model`). Surfaces reuse THIS instance for the `/sticky-model`
   *  SET command so SET and the loop's CONSUME read the same store. */
  stickyModelStore(): RuntimeContextStickyModelStoreView
  decisionEmitter(): RuntimeContextDecisionEmitterView
  admissibility(): RuntimeContextAdmissibilityView
  planExitPort(): RuntimeContextPlanExitPortView
  userInputPort(): RuntimeContextUserInputPortView
  /** H16 — the live cross-session dream trigger (the SAME instance the session-
   *  end auto path fires), present iff the host wired one (`QUANTA_AUTO_DREAM=1`).
   *  The REPL surface reuses THIS instance for the `/dream` manual trigger so the
   *  manual + auto paths share one consolidation core (no duplication). */
  dreamTrigger(): RuntimeContextDreamTriggerView
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
    host: applyRuntimeFacadeComposeOptions(binding, args.compose).createRuntimeHost(
      (() => {
        const { compose: _compose, ...hostArgs } = args
        return hostArgs
      })(),
    ),
  })

const unwrapRuntimeContext = (context: RuntimeContext): RuntimeContextRecord =>
  context as RuntimeContextRecord

const patchRuntimeContextState = (
  state: InternalRuntimeContextState,
  patch: RuntimeContextPatch,
): InternalRuntimeContextState => state.patch(patch)

/** The compose keys that pass STRAIGHT through to the runtime-context snapshot
 *  (a present value ⇒ a single-key `patch`). Each is structurally identical, so
 *  they fold into one data-driven loop (keeping
 *  {@link applyRuntimeFacadeComposeOptions} under the complexity budget). The
 *  two NON-uniform keys (`registryToolMapper`, `automationEngine` — they derive
 *  a new `registry`) stay as explicit branches below. ADR-0512 added
 *  `onSkillScopeReady` to this set. */
const PASS_THROUGH_COMPOSE_KEYS = [
  "onPromptAssembled",
  "workingState",
  "onWorkingStateReady",
  "onSkillScopeReady",
  "onTurnStreamInput",
  "shadowOdb",
  "shadowCheckpoint",
  "onPreCompact",
  "imageSanitizationRetry",
  "gitObservability",
  "conversationActionPort",
  "activeTurnRef",
  "radar",
  "browserNet",
  "objective",
  "roleModelResolver",
] as const satisfies readonly (keyof RuntimeFacadeComposeOptions & keyof RuntimeContextPatch)[]

const applyRuntimeFacadeComposeOptions = (
  binding: RuntimeContextBinding,
  compose: RuntimeFacadeComposeOptions | undefined,
): RuntimeContextBinding => {
  if (compose === undefined) return binding
  let next = binding
  for (const key of PASS_THROUGH_COMPOSE_KEYS) {
    const value = compose[key]
    if (value !== undefined) {
      next = patchRuntimeContextState(next, { [key]: value } as RuntimeContextPatch)
    }
  }
  if (compose.registryToolMapper !== undefined) {
    const registry = next.snapshot.registry
    const { registryToolMapper } = compose
    next = patchRuntimeContextState(next, {
      registry: new ToolRegistry(registry.all().map((tool) => registryToolMapper(tool))),
    })
  }
  if (compose.automationEngine !== undefined) {
    const registry = next.snapshot.registry
    next = patchRuntimeContextState(next, {
      automationEngine: compose.automationEngine,
      registry: registry.has("automation_update")
        ? registry
        : new ToolRegistry([
            ...registry.all(),
            automationUpdateTool(compose.automationEngine.engine),
          ]),
    })
  }
  return next
}

const summarizeRuntimeSnapshot = (snapshot: RuntimeContextSnapshot): RuntimeWireSummary => ({
  executionPlane: {
    conversationCheckpoint: snapshot.conversationCheckpoint !== undefined,
    responsesContinuation: snapshot.responsesContinuation !== undefined,
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
    materializeReviewerAgent: (boot, turnAssembler) =>
      record.state.materializeReviewerAgent(boot, turnAssembler),
    registry: () => record.state.snapshot.registry,
    permissionMode: () => record.state.snapshot.permission.mode,
    permissionModeState: () => record.state.snapshot.permissionModeState,
    automationEngine: () => record.state.snapshot.automationEngine,
    toolProfileState: () => record.state.snapshot.toolProfileState,
    identityModeState: () => record.state.snapshot.identityModeState,
    focusChain: () => record.state.snapshot.focusChain,
    stickyModelStore: () => record.state.snapshot.stickyModelStore,
    decisionEmitter: () => record.state.snapshot.decisionEmitter,
    admissibility: () => record.state.snapshot.admissibility,
    planExitPort: () => record.state.snapshot.planExitPort,
    userInputPort: () => record.state.snapshot.userInputPort,
    dreamTrigger: () => record.state.snapshot.dreamTrigger,
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
  runtimeContext.materializeReviewerAgent(boot, turnAssembler)

export const summarizeRuntimeContext = (runtimeContext: RuntimeContext): RuntimeWireSummary =>
  summarizeRuntimeSnapshot(unwrapRuntimeContext(runtimeContext).state.snapshot)

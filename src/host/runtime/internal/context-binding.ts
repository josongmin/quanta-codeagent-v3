import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationInheritance,
  SessionHostSideConversationResult,
  SessionHostTurnEvent,
} from "@/kernel/session"
import type { ContentBlock, ImageBlock, Message, ResponsesContinuationStore } from "@/llm"
import type { CrossSessionDreamTrigger } from "@/memory"
import { inferReviewKind, isPermissionMode, reasonCodeFor, type ToolAction } from "@/permission"
import type { CapabilityManifest, PendingApprovalView } from "@/protocol/session"
import { wireInteractiveKnobs } from "@/runner/assemble"
import type {
  IdentityModeSessionState,
  PermissionModeSessionState,
  SystemSource,
  ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import { persistTurn } from "@/runner/orchestrate/persist-turn"
import { buildSharedExecutionPlaneRuntimeAugments } from "@/runner/session-execution-plane"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import type {
  RuntimeAgentConfigBase,
  RuntimeAgentTurnAssembler,
  RuntimeAgentTurnDeps,
} from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import { sliceWholeChars } from "@/shared"
import type { AgentEvent } from "@/stream"
import { automationUpdateTool, type Tool, ToolRegistry } from "@/tool"
import { createSingleSessionRuntimeHost } from "../builder"
import { deriveCapabilityManifest } from "../capabilities"
import type { RuntimeHost, RuntimeSessionConfig } from "../types"
import { installCliMentionInjector } from "./mention-wire"

type RuntimeBase = RuntimeAgentConfigBase & {
  approvalProtocol?: RuntimeApprovalProtocolConfig
  systemSource?: SystemSource
  toolProfileState?: ToolProfileSessionState
  identityModeState?: IdentityModeSessionState
  permissionModeState?: PermissionModeSessionState
  /** Session-scoped teardown for the memory-auto wires (audit U7-10): closes
   *  the bun:sqlite WAL handle opened by buildSessionMemoryAutoWires. Idempotent.
   *  Invoked once from the session host's close(); undefined when memory-auto is
   *  off. Per-SESSION, never per-turn (the handle is reused across turns). */
  memoryAutoDispose?: () => void
  /** Await the deferred Phase-1 consolidation lane (the per-turn distill
   *  `runAgent` hands off via `memoryConsolidator.defer` so it never blocks
   *  the turn-completion path). Awaited once from the session host's close(),
   *  BEFORE {@link memoryAutoDispose} — the distill writes to the sqlite
   *  handle dispose closes. Undefined when memory-auto is off. */
  memoryAutoDrain?: () => Promise<void>
  /** H16 — session-end cross-session auto-dream hook. Present only when
   *  `QUANTA_AUTO_DREAM=1` produced a trigger; invoked once (awaited) from the
   *  session host's close() AFTER the WAL dispose. Best-effort + bounded by the
   *  trigger's own dream-lock; undefined ⇒ no dream (byte-identical default). */
  dreamOnSessionEnd?: () => Promise<void>
  /** H16 — the SAME cross-session dream trigger instance backing
   *  `dreamOnSessionEnd`, exposed so the REPL surface can wire `/dream` to it
   *  (manual override of the cadence gate) reusing the auto path's consolidation
   *  core — no duplicated consolidate/state/write-target. Present only when
   *  `QUANTA_AUTO_DREAM=1` produced a trigger; undefined ⇒ `/dream` prints
   *  "not wired" (byte-identical default-OFF). */
  dreamTrigger?: CrossSessionDreamTrigger
}

interface RuntimeConfirmSlot {
  current: NonNullable<AgentConfig["onConfirm"]>
}

interface RuntimeApprovalProtocolConfig {
  readonly confirmSlot: RuntimeConfirmSlot
  /** jun-10 HITL restructure — the surface has a LIVE OPERATOR (interactive
   *  CLI): a mid-turn "ask" should delegate INLINE to the surface confirm that
   *  was in the slot at `runWithProtocol` entry, instead of minting a pending
   *  approval and aborting the whole turn (the deferred protocol re-runs the
   *  turn from scratch — re-paying the full prompt per approval). Absent/false
   *  ⇒ byte-identical deferred behavior (web/SDK/headless round-trip). */
  readonly interactive?: boolean
}

interface BootBindings {
  readonly mode: SessionBootstrapResult["mode"]
  readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
  readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
  readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
}

interface RuntimeContextSnapshot {
  readonly registry: AgentConfig["registry"]
  readonly permission: AgentConfig["permission"]
  readonly systemSource?: SystemSource
  readonly automationEngine?: AgentConfig["automationEngine"]
  readonly toolProfileState?: ToolProfileSessionState
  readonly identityModeState?: IdentityModeSessionState
  readonly permissionModeState?: PermissionModeSessionState
  readonly focusChain?: AgentConfig["focusChain"]
  readonly stickyModelStore?: AgentConfig["stickyModelStore"]
  readonly decisionEmitter?: AgentConfig["decisionEmitter"]
  readonly admissibility?: AgentConfig["admissibility"]
  readonly planExitPort?: AgentConfig["planExitPort"]
  readonly userInputPort?: AgentConfig["userInputPort"]
  readonly conversationCheckpoint?: AgentConfig["conversationCheckpoint"]
  readonly responsesContinuation?: AgentConfig["responsesContinuation"]
  readonly fork?: AgentConfig["fork"]
  readonly forkSession?: AgentConfig["forkSession"]
  readonly delegation?: AgentConfig["delegation"]
  readonly subagentBackground?: AgentConfig["subagentBackground"]
  readonly autoBackground?: AgentConfig["autoBackground"]
  readonly sessionCtx?: AgentConfig["sessionCtx"]
  readonly stage1OutputsStore?: AgentConfig["stage1OutputsStore"]
  readonly memoryConsolidator?: AgentConfig["memoryConsolidator"]
  readonly granularRegistry?: AgentConfig["granularRegistry"]
  readonly onPromptAssembled?: AgentConfig["onPromptAssembled"]
  readonly workingState?: AgentConfig["workingState"]
  readonly onWorkingStateReady?: AgentConfig["onWorkingStateReady"]
  readonly onSkillScopeReady?: AgentConfig["onSkillScopeReady"]
  readonly onTurnStreamInput?: AgentConfig["onTurnStreamInput"]
  readonly shadowOdb?: AgentConfig["shadowOdb"]
  readonly shadowCheckpoint?: AgentConfig["shadowCheckpoint"]
  readonly onPreCompact?: AgentConfig["onPreCompact"]
  readonly imageSanitizationRetry?: AgentConfig["imageSanitizationRetry"]
  readonly gitObservability?: AgentConfig["gitObservability"]
  readonly conversationActionPort?: AgentConfig["conversationActionPort"]
  readonly activeTurnRef?: AgentConfig["activeTurnRef"]
  readonly shadowVerify?: AgentConfig["shadowVerify"]
  /** H16 — the live cross-session dream trigger (auto path's SAME instance),
   *  surfaced so the REPL can wire `/dream`. Present only when
   *  `QUANTA_AUTO_DREAM=1` produced a trigger. */
  readonly dreamTrigger?: CrossSessionDreamTrigger
}

type RuntimeContextPatch = Partial<
  Pick<
    RuntimeContextSnapshot,
    | "registry"
    | "permission"
    | "systemSource"
    | "automationEngine"
    | "toolProfileState"
    | "identityModeState"
    | "focusChain"
    | "stickyModelStore"
    | "decisionEmitter"
    | "admissibility"
    | "planExitPort"
    | "userInputPort"
    | "conversationCheckpoint"
    | "responsesContinuation"
    | "fork"
    | "forkSession"
    | "delegation"
    | "subagentBackground"
    | "autoBackground"
    | "sessionCtx"
    | "stage1OutputsStore"
    | "memoryConsolidator"
    | "granularRegistry"
    | "onPromptAssembled"
    | "workingState"
    | "onWorkingStateReady"
    | "onSkillScopeReady"
    | "onTurnStreamInput"
    | "shadowOdb"
    | "shadowCheckpoint"
    | "onPreCompact"
    | "imageSanitizationRetry"
    | "gitObservability"
    | "conversationActionPort"
    | "activeTurnRef"
    | "shadowVerify"
  >
>

interface CreateRuntimeContextHostArgs {
  readonly boot?: BootBindings
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

interface RuntimeContextBindingState {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

interface RuntimeContextBinding {
  readonly snapshot: RuntimeContextSnapshot
  patch(patch: RuntimeContextPatch): RuntimeContextBinding
  createRuntimeHost(args: CreateRuntimeContextHostArgs): RuntimeHost
  materializeReviewerAgent(
    boot: SessionBootstrapResult,
    turnAssembler?: RuntimeAgentTurnAssembler,
  ): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]>
}

interface RuntimeExecutionComposeArgs {
  readonly history: readonly Message[]
  readonly base: RuntimeBase
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

interface RuntimeMemoryAutoComposeArgs {
  readonly base: RuntimeBase
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly now?: () => number
  readonly logWarn?: (msg: string) => void
}

type RuntimeBootstrapOverlay = {
  readonly approvalProtocol?: RuntimeApprovalProtocolConfig
  readonly admissibility?: AgentConfig["admissibility"]
  readonly admissibilityBuilder?: (
    helpers: RuntimeBootstrapHelpers,
  ) => AgentConfig["admissibility"] | undefined | Promise<AgentConfig["admissibility"] | undefined>
  readonly decisionEmitter?: AgentConfig["decisionEmitter"]
  readonly planExitPort?: AgentConfig["planExitPort"]
  readonly shellSnapshot?: AgentConfig["shellSnapshot"]
  readonly summarizerLlm?: NonNullable<AgentConfig["compaction"]>["summarizerLlm"]
  readonly userInputPort?: AgentConfig["userInputPort"]
  /** ADR-0428 jun-02 wire — socket-level egress proxy config. When set, the
   *  base carries `networkProxy` so `runAgent` constructs the live
   *  `LoopbackEgressProxy` and threads `proxyEnv` into the bash-tool child
   *  spawn. Absent ⇒ slot omitted (default-OFF, byte-identical). */
  readonly networkProxy?: AgentConfig["networkProxy"]
  /** F2 (round-2) — host-wired named-agent resolver (`loadNamedAgents(cwd)`).
   *  When set, the base carries `namedAgentResolver` so the per-turn assembled
   *  `AgentConfig` (and thus the SubagentRunner the loop builds) resolves a
   *  spawn's `agentType` to a `.quanta/agents` definition — parity with the
   *  headless `apps/agent` surface, which threads the same resolver via its
   *  `AssembleRequestPartial`. Absent ⇒ slot omitted (default-OFF,
   *  byte-identical: no named agent ever resolves). */
  readonly namedAgentResolver?: AgentConfig["namedAgentResolver"]
  /** ticket-11 (P8 git-worktree agent tools) — session-scoped active-worktree
   *  slot. When set (the comp-root mints ONE per session behind
   *  `QUANTA_WORKTREE_TOOL`), the base carries `activeWorktreeSlot` so features.ts
   *  registers the enter/exit/worktree_status tools AND the dispatch seam projects
   *  the slot's current value onto the bash/edit relative-cwd edit-fence. Absent ⇒
   *  slot omitted (default-OFF, byte-identical: tools unregistered, bash/edit cwd
   *  unchanged). */
  readonly activeWorktreeSlot?: AgentConfig["activeWorktreeSlot"]
}

interface RuntimeBootstrapHelpers {
  materializeReviewerAgent(
    boot: SessionBootstrapResult,
    turnAssembler?: RuntimeAgentTurnAssembler,
  ): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]>
}

interface CreateRuntimeContextBindingFromBootstrapArgs {
  readonly boot: SessionBootstrapResult
  readonly stream: AgentConfig["stream"]
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  readonly includeSearchPipeline?: boolean
  readonly overlay?: RuntimeBootstrapOverlay
  readonly execution?: Omit<RuntimeExecutionComposeArgs, "base" | "turnAssembler">
  readonly memoryAuto?: Omit<RuntimeMemoryAutoComposeArgs, "base">
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

const whenDefined = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>)

const withDefinedProps = <T extends object>(record: T): T => {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  return Object.fromEntries(entries) as T
}

const sanitizeRuntimeBase = <T extends object>(base: T): RuntimeBase =>
  withDefinedProps(base) as unknown as RuntimeBase

const ensureSessionId = (base: RuntimeBase): RuntimeBase =>
  base.sessionId === undefined
    ? sanitizeRuntimeBase({ ...base, sessionId: crypto.randomUUID() })
    : sanitizeRuntimeBase(base)

const getSessionId = (base: RuntimeBase): string => base.sessionId ?? crypto.randomUUID()

const DEFAULT_RUNTIME_ENV: Readonly<Record<string, string | undefined>> = process.env

const wireRuntimePorts = (
  base: RuntimeBase,
  env: Readonly<Record<string, string | undefined>> = DEFAULT_RUNTIME_ENV,
): RuntimeBase => sanitizeRuntimeBase(wireOptionalAgentPorts(base, env))

const buildCapabilityManifest = (base: RuntimeBase): CapabilityManifest =>
  deriveCapabilityManifest({
    approvals: base.onConfirm !== undefined,
    tools: base.registry.all().length > 0,
    memory:
      base.store !== undefined ||
      base.memoryConsolidator !== undefined ||
      base.memory !== undefined,
    artifacts: false,
    subagents:
      base.subagent !== undefined ||
      base.delegation !== undefined ||
      base.subagentBackground !== undefined,
    automation: base.automationEngine !== undefined,
    shellSnapshot: base.shellSnapshot !== undefined,
    transport: "inproc",
  })

const toToolProfileConfig = (state: ToolProfileSessionState | undefined): Partial<AgentConfig> =>
  state === undefined
    ? {}
    : {
        toolProfile: {
          resolver: state.resolver,
          ...(state.defaultName !== undefined ? { defaultName: state.defaultName } : {}),
          activeName: () => state.get() ?? state.defaultName ?? "write",
        },
      }

const toIdentityModeConfig = (state: IdentityModeSessionState | undefined): Partial<AgentConfig> =>
  state === undefined
    ? {}
    : {
        identityModeVariant: {
          registry: state.registry,
          ...(state.perTurnReminderEnabled !== undefined
            ? { perTurnReminderEnabled: state.perTurnReminderEnabled }
            : {}),
          activeMode: () => state.get() ?? state.defaultMode ?? "default",
        },
      }

const buildTurnAssemblerDeps = (args: {
  readonly base: RuntimeBase
  readonly messages: readonly Message[]
  readonly signal: AbortSignal | undefined
}): RuntimeAgentTurnDeps => {
  const {
    approvalProtocol: _approvalProtocol,
    systemSource,
    messages: _baseMessages,
    signal: _baseSignal,
    system,
    ...rest
  } = args.base

  return withDefinedProps({
    ...(rest as RuntimeAgentTurnDeps),
    messages: [...args.messages],
    system: systemSource?.get() ?? system,
    signal: args.signal ?? args.base.signal,
    ...(systemSource !== undefined ? { systemSource } : {}),
  })
}

const buildAgentConfigFromBase = (args: {
  readonly base: RuntimeBase
  readonly messages: readonly Message[]
  readonly signal?: AbortSignal
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}): AgentConfig => {
  if (args.turnAssembler !== undefined) {
    return installCliMentionInjector(
      args.turnAssembler(
        [...args.messages],
        buildTurnAssemblerDeps({
          base: args.base,
          messages: args.messages,
          signal: args.signal,
        }),
      ),
    )
  }

  const {
    approvalProtocol: _approvalProtocol,
    systemSource,
    toolProfileState,
    identityModeState,
    messages: _baseMessages,
    signal: _baseSignal,
    system,
    ...rest
  } = args.base

  return installCliMentionInjector({
    ...(rest as Omit<AgentConfig, "messages" | "signal" | "system">),
    messages: [...args.messages],
    system: systemSource?.get() ?? system,
    signal: args.signal ?? args.base.signal,
    ...toToolProfileConfig(toolProfileState),
    ...toIdentityModeConfig(identityModeState),
  })
}

const buildAgentConfigFromBaseInput = (args: {
  readonly base: RuntimeBase
  readonly messages: readonly Message[]
  readonly signal: AbortSignal | undefined
  readonly turnAssembler: RuntimeAgentTurnAssembler | undefined
}): Parameters<typeof buildAgentConfigFromBase>[0] => ({
  base: args.base,
  messages: args.messages,
  ...(args.signal !== undefined ? { signal: args.signal } : {}),
  ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
})

const buildCompactionConfig = (args: {
  readonly store: AgentConfig["store"]
  readonly summarizerLlm?: NonNullable<AgentConfig["compaction"]>["summarizerLlm"]
}): AgentConfig["compaction"] | undefined => {
  if (args.store === undefined && args.summarizerLlm === undefined) return undefined
  return args.summarizerLlm !== undefined ? { summarizerLlm: args.summarizerLlm } : {}
}

const ensureAutomationRegistry = (
  registry: AgentConfig["registry"],
  automationEngine: AgentConfig["automationEngine"] | undefined,
): AgentConfig["registry"] => {
  if (automationEngine === undefined || registry.has("automation_update")) return registry
  return new ToolRegistry([...registry.all(), automationUpdateTool(automationEngine.engine)])
}

const buildBaseFromBootstrap = (args: {
  readonly boot: SessionBootstrapResult
  readonly stream: AgentConfig["stream"]
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  readonly includeSearchPipeline?: boolean
  readonly overlay?: RuntimeBootstrapOverlay
}): RuntimeBase => {
  const compaction = buildCompactionConfig({
    store: args.boot.tooling.store,
    summarizerLlm: args.overlay?.summarizerLlm,
  })

  // jun-02 — fold the three INTERACTIVE knobs (advisor / task-budget /
  // compose-authoring) at the CLI composition root, reusing each knob's own
  // parse+apply so the env→config semantics match the matrix. Without this the
  // knobs were DEAD on the live CLI surface (`applyKnobs` is bench-only). The
  // env view is `process.env` — consistent with `wireRuntimePorts` (which also
  // defaults to `process.env` at this same composition boundary). Absent env ⇒
  // base unchanged (byte-identical).
  return wireInteractiveKnobs(buildBootstrapBaseShape(args, compaction), process.env, "cli")
}

const buildBootstrapBaseShape = (
  args: {
    readonly boot: SessionBootstrapResult
    readonly stream: AgentConfig["stream"]
    readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
    readonly includeSearchPipeline?: boolean
    readonly overlay?: RuntimeBootstrapOverlay
  },
  compaction: AgentConfig["compaction"] | undefined,
): RuntimeBase => {
  return ensureSessionId({
    llm: args.boot.llm,
    registry: ensureAutomationRegistry(args.boot.tooling.registry, undefined),
    stream: args.stream,
    permission: args.boot.permission,
    messages: [...args.boot.history],
    system: args.boot.system,
    ...whenDefined("systemSource", args.boot.systemSource),
    cwd: args.boot.cwd,
    maxTurns: args.boot.maxTurns,
    signal: args.boot.abort.signal,
    onConfirm: args.onConfirm,
    ...whenDefined("sessionId", args.boot.sessionId),
    ...whenDefined("store", args.boot.tooling.store),
    ...whenDefined("compaction", compaction),
    ...whenDefined("embedder", args.boot.tooling.embedder),
    ...whenDefined("memory", args.boot.tooling.memoryConfig),
    ...(args.boot.features.planMode ? { planMode: true } : {}),
    ...whenDefined("metrics", args.boot.features.metrics),
    ...whenDefined("run", args.boot.run),
    ...whenDefined("subagent", args.boot.tooling.subagentConfig),
    ...whenDefined("skills", args.boot.tooling.skillsConfig),
    ...whenDefined("compactionBreaker", args.boot.tooling.compactionBreakerConfig),
    ...whenDefined("verifyGuard", args.boot.tooling.verifyGuardConfig),
    // ADR-0432 — set the session budget meter when the operator opted into the
    // write-guard (bootstrap constructs it ONLY then). The loop's existing tick
    // sites feed it; the write-guard reads `() => meter.remainingPercent()`
    // (threaded into buildTooling). Absent ⇒ slot omitted (byte-identical).
    ...whenDefined("budgetMeter", args.boot.budgetMeter),
    ...whenDefined(
      "searchPipeline",
      args.includeSearchPipeline === true ? args.boot.tooling.searchPipeline : undefined,
    ),
    ...whenDefined("approvalProtocol", args.overlay?.approvalProtocol),
    ...whenDefined("planExitPort", args.overlay?.planExitPort),
    ...whenDefined("userInputPort", args.overlay?.userInputPort),
    ...whenDefined("toolProfileState", args.boot.toolProfileState),
    ...whenDefined("identityModeState", args.boot.identityModeState),
    ...whenDefined("permissionModeState", args.boot.permissionModeState),
    ...whenDefined("focusChain", args.boot.focusChain),
    ...whenDefined("onShellEvent", args.boot.onShellEvent),
    ...whenDefined("workMetricsSink", args.boot.workMetricsSink),
    ...whenDefined("followUpQueue", args.boot.lifecycleFollowUpQueue),
    ...whenDefined("planStore", args.boot.planStore),
    ...whenDefined("decisionEmitter", args.overlay?.decisionEmitter),
    ...whenDefined("admissibility", args.overlay?.admissibility),
    ...whenDefined("shellSnapshot", args.overlay?.shellSnapshot),
    ...whenDefined("networkProxy", args.overlay?.networkProxy),
    // F2 (round-2) — lift the host-wired named-agent resolver onto the base so
    // the per-turn `assembleAgentConfig` spread carries it to the SubagentRunner.
    ...whenDefined("namedAgentResolver", args.overlay?.namedAgentResolver),
    // ticket-11 (P8) — lift the session-scoped active-worktree slot onto the base
    // so features.ts registers the worktree tools and the dispatch seam projects
    // the slot value onto the bash/edit edit-fence. Absent ⇒ omitted (default-OFF).
    ...whenDefined("activeWorktreeSlot", args.overlay?.activeWorktreeSlot),
    ...whenDefined("sessionConfigPort", args.boot.sessionConfigPort),
    // jun-6 (RFC jun-6-ai-session-title) — spread the AI titler ONLY when the
    // surface built it (knob on + cheap model). Absent ⇒ slot omitted ⇒ the
    // loop's first-turn title branch is dead (byte-identical default-OFF).
    ...whenDefined("autoTitlePort", args.boot.autoTitlePort),
    sessionEffort: () => args.boot.effortStore.get(),
  })
}

const extendBaseWithExecutionPlane = async (
  args: RuntimeExecutionComposeArgs,
): Promise<RuntimeBase> => {
  const parentConfig = buildAgentConfigFromBase(
    buildAgentConfigFromBaseInput({
      base: args.base,
      messages: [...args.history],
      signal: args.base.signal,
      turnAssembler: args.turnAssembler,
    }),
  )
  const augments = await buildSharedExecutionPlaneRuntimeAugments({
    history: args.history,
    parentConfig,
    subagentConfig: args.base.subagent,
    cwd: args.cwd,
    envSource: args.envSource,
    ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
    ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
  })
  return { ...args.base, ...augments }
}

const extendBaseWithMemoryAuto = async (
  args: RuntimeMemoryAutoComposeArgs,
): Promise<RuntimeBase> => {
  const auto = await buildSessionMemoryAutoWires({
    env: args.env,
    llm: args.base.llm,
    ...(args.base.compaction?.summarizerLlm !== undefined
      ? { summarizerLlm: args.base.compaction.summarizerLlm }
      : {}),
    sessionId: getSessionId(args.base),
    signal: args.base.signal,
    ...(args.homeDir !== undefined ? { homeDir: args.homeDir } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
    ...(args.logWarn !== undefined ? { logWarn: args.logWarn } : {}),
  })
  if (auto === undefined) return args.base
  const dreamTrigger = auto.dreamTrigger
  return {
    ...args.base,
    ...(auto.sessionCtx !== undefined ? { sessionCtx: auto.sessionCtx } : {}),
    stage1OutputsStore: auto.stage1OutputsStore,
    memoryConsolidator: auto.memoryConsolidator,
    // U7-10: carry the WAL-handle teardown onto the base so the session host's
    // close() releases the fd. Previously `auto.dispose` was dropped here, so
    // every memory-auto session leaked its sqlite handle for the host lifetime.
    memoryAutoDispose: auto.dispose,
    // Deferred-consolidation drain — close() awaits this BEFORE the dispose
    // above so an in-flight background distill finishes writing to the sqlite
    // store before the WAL handle is released.
    memoryAutoDrain: auto.drain,
    // H16 — carry the session-end auto-dream hook (default-OFF: absent unless
    // QUANTA_AUTO_DREAM=1 produced a trigger). The host fires it once at close().
    // Also carry the SAME trigger instance so the REPL surface can wire `/dream`
    // (manual override) over the auto path's consolidation core — no duplication.
    ...(dreamTrigger !== undefined
      ? {
          dreamOnSessionEnd: () => dreamTrigger.onSessionEnd().then(() => undefined),
          dreamTrigger,
        }
      : {}),
  }
}

const buildOptionalSnapshotFields = (
  base: RuntimeBase,
): Partial<Omit<RuntimeContextSnapshot, "registry" | "permission">> => ({
  ...whenDefined("systemSource", base.systemSource),
  ...whenDefined("automationEngine", base.automationEngine),
  ...whenDefined("toolProfileState", base.toolProfileState),
  ...whenDefined("identityModeState", base.identityModeState),
  ...whenDefined("permissionModeState", base.permissionModeState),
  ...whenDefined("focusChain", base.focusChain),
  ...whenDefined("stickyModelStore", base.stickyModelStore),
  ...whenDefined("decisionEmitter", base.decisionEmitter),
  ...whenDefined("admissibility", base.admissibility),
  ...whenDefined("planExitPort", base.planExitPort),
  ...whenDefined("userInputPort", base.userInputPort),
  ...whenDefined("conversationCheckpoint", base.conversationCheckpoint),
  ...whenDefined("responsesContinuation", base.responsesContinuation),
  ...whenDefined("fork", base.fork),
  ...whenDefined("forkSession", base.forkSession),
  ...whenDefined("delegation", base.delegation),
  ...whenDefined("subagentBackground", base.subagentBackground),
  ...whenDefined("autoBackground", base.autoBackground),
  ...whenDefined("sessionCtx", base.sessionCtx),
  ...whenDefined("stage1OutputsStore", base.stage1OutputsStore),
  ...whenDefined("memoryConsolidator", base.memoryConsolidator),
  ...whenDefined("granularRegistry", base.granularRegistry),
  ...whenDefined("onPromptAssembled", base.onPromptAssembled),
  ...whenDefined("workingState", base.workingState),
  ...whenDefined("onWorkingStateReady", base.onWorkingStateReady),
  ...whenDefined("onSkillScopeReady", base.onSkillScopeReady),
  ...whenDefined("onTurnStreamInput", base.onTurnStreamInput),
  ...whenDefined("shadowOdb", base.shadowOdb),
  ...whenDefined("shadowCheckpoint", base.shadowCheckpoint),
  ...whenDefined("onPreCompact", base.onPreCompact),
  ...whenDefined("imageSanitizationRetry", base.imageSanitizationRetry),
  ...whenDefined("gitObservability", base.gitObservability),
  ...whenDefined("conversationActionPort", base.conversationActionPort),
  ...whenDefined("activeTurnRef", base.activeTurnRef),
  ...whenDefined("shadowVerify", base.shadowVerify),
  ...whenDefined("dreamTrigger", base.dreamTrigger),
})

const buildSnapshot = (base: RuntimeBase): RuntimeContextSnapshot => ({
  registry: base.registry,
  permission: base.permission,
  ...buildOptionalSnapshotFields(base),
})

const SIDE_CONVERSATION_MAX_TURNS_CAP = 5

const SIDE_CONVERSATION_DEFAULT_TOOLS: readonly string[] = Object.freeze([
  "read",
  "search_codebase",
  "grep",
  "glob",
  "file_tree_summary",
  "parse_test_failure",
  "localize",
  "diagnostics",
  "git_log",
  "git_diff",
  "git_blame",
  "git_blame_heatmap",
  "git_churn",
  "git_status",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
])

const SIDE_CONVERSATION_FORBIDDEN = new Set<string>([
  "write",
  "edit",
  "apply_patch",
  "scripted_replace",
  "bash",
  "git_commit",
  "git_push",
  "git_reset",
  "git_revert",
  "git_checkout",
  "git_branch_delete",
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "exec_command",
  "write_stdin",
  "send_input",
])

const buildSideConversationRegistry = (
  source: ToolRegistry,
  allowlist: readonly string[],
): ToolRegistry => {
  const allowed: Tool[] = []
  for (const name of allowlist) {
    if (SIDE_CONVERSATION_FORBIDDEN.has(name)) continue
    const tool = source.get(name)
    if (tool !== undefined) allowed.push(tool)
  }
  return new ToolRegistry(allowed)
}

const buildSideConversationHistory = (
  mainHistory: readonly Message[],
  mode: SessionHostSideConversationInheritance,
): Message[] => {
  if (mode === "none" || mode === "system") return []
  const out: Message[] = []
  let lastAssistantIdx = -1
  for (let i = mainHistory.length - 1; i >= 0; i--) {
    const message = mainHistory[i]
    if (message?.role === "assistant") {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx < 1) return out
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    const message = mainHistory[i]
    if (message?.role === "user") {
      out.push(message, mainHistory[lastAssistantIdx] as Message)
      break
    }
  }
  return out
}

const extractSideConversationAnswerText = (outcome: AgentOutcome): string => {
  for (let i = outcome.messages.length - 1; i >= 0; i--) {
    const message = outcome.messages[i]
    if (message?.role !== "assistant") continue
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
  }
  return ""
}

interface UsageTally {
  inputTokens: number
  outputTokens: number
}

const createUsageTallyStream = (
  source: AgentConfig["stream"],
  tally: UsageTally,
): AgentConfig["stream"] => ({
  emit(event) {
    if (event.type === "usage") {
      tally.inputTokens += event.inputTokens ?? 0
      tally.outputTokens += event.outputTokens ?? 0
    }
    source.emit(event)
  },
})

const mintSideConversationSessionId = (mainSessionId: string): string =>
  `side:${mainSessionId}:${Math.random().toString(36).slice(2, 10)}`

export class RuntimeApprovalRequiredError extends Error {
  readonly approval: PendingApprovalView

  constructor(approval: PendingApprovalView) {
    super(`runtime approval required: ${approval.reason}`)
    this.name = "RuntimeApprovalRequiredError"
    this.approval = approval
  }
}

const isRuntimeApprovalRequiredError = (error: unknown): error is RuntimeApprovalRequiredError =>
  error instanceof RuntimeApprovalRequiredError

interface PendingRuntimeApprovalRecord {
  readonly approval: PendingApprovalView
  readonly actionKey: string
  /** False when shell extraction threw at mint time (the stored `actionKey` is
   *  a diagnostics-only sentinel string). A non-grantable record still mints
   *  the single-use lease (which can never match — fail closed, re-prompts)
   *  but must NEVER mint a standing session grant. */
  readonly grantable: boolean
}

/** T03 (audit L5 H-1/M-3) — an approval grant is an opaque, single-use LEASE
 *  scoped to ONE turn/action instance, not a broad action-kind key held for the
 *  session lifetime. The lease carries the `actionKey` it satisfies so a re-run
 *  of the approved action matches, but it is keyed by the opaque `approvalId`
 *  so two concurrent same-`actionKey` actions can NOT share one grant. */
interface RuntimeApprovalLease {
  readonly approvalId: string
  readonly actionKey: string
  /** ADR-0512 P3 — the operator's RICH decision, set ONLY when the resolved
   *  approval was a skill-scope escalation (`scopeContext` present). When set,
   *  `claimLease` returns it verbatim so the loop's `decideScopeEscalation`
   *  honours `allow_once` (scope:"once" ⇒ no widen) / `deny_and_steer` (steer).
   *  Absent on a NORMAL approval ⇒ `claimLease` returns bare `true`
   *  (byte-identical to the pre-ADR-0512 grant). */
  readonly decision?: ConfirmDecision
}

/** Sentinel returned by {@link actionKeyOf} when shell extraction throws. A
 *  thrown extraction must FAIL CLOSED (force a prompt) rather than collapse to a
 *  broad tool-name-only key that a stale lease could match (audit L5 H-1). */
const SHELL_EXTRACT_FAILED = Symbol("shell-extract-failed")

const actionKeyOf = (
  registry: ToolRegistry,
  action: ToolAction,
): string | typeof SHELL_EXTRACT_FAILED => {
  let shellCommand: string | null
  try {
    shellCommand = registry.extractShellCommand(action.tool, action.input)
  } catch {
    return SHELL_EXTRACT_FAILED
  }
  return shellCommand !== null ? `${action.tool}|${shellCommand}` : action.tool
}

const reasonOf = (action: ToolAction): PendingApprovalView["reason"] =>
  reasonCodeFor(inferReviewKind(action.tool, action.isReadOnly))

/** ADR-0512 P3 — when a confirm is a skill-scope ESCALATION (`action.scopeContext`
 *  present, set by `decideScopeEscalation`), project it onto the approval's
 *  `scopeContext` so the web/IDE surface renders the rich "outside skill scope"
 *  card (the CLI gets the same data via the `permission_escalation_requested`
 *  stream event). `risk` is derived from the SAME `isReadOnly` predicate the
 *  card and dispatch share (read-only ⇒ "read-only", else "mutating"), so the
 *  card's risk and the dispatch decision can never disagree. A normal confirm
 *  has no `scopeContext` ⇒ this returns `{}` ⇒ the field is omitted ⇒ the minted
 *  approval is byte-identical to every pre-ADR-0512 approval. The model's
 *  `justification` is forwarded only when the escalation carried one. */
const escalationScopeFields = (action: ToolAction): Pick<PendingApprovalView, "scopeContext"> => {
  const scope = action.scopeContext
  if (scope === undefined) return {}
  // `justification` is OPTIONAL on the escalation's `scopeContext` (Codex
  // `on-request` rationale, seeded from the model's pre-tool prose). The action
  // carries it only when the escalation set it; forward it through when present
  // so the web/IDE card can render the row.
  const justification = scope.justification
  return {
    scopeContext: {
      tool: action.tool,
      activeSkill: scope.activeSkill,
      reason: scope.reason,
      risk: action.isReadOnly ? "read-only" : "mutating",
      ...(justification !== undefined ? { justification } : {}),
    },
  }
}

const approvalPlaceholderOutcome = (messages: readonly Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})

export const createRuntimeApprovalProtocolController = (base: RuntimeBase) => {
  const pending = new Map<string, PendingRuntimeApprovalRecord>()
  // T03 — leases keyed by opaque approvalId (NOT a broad actionKey). Single-use
  // and turn-scoped: a lease that enters a `runWithProtocol` scope without being
  // consumed is cleared when that scope exits, so an approval cannot leak past
  // the immediate re-run (audit L5 H-1).
  const leases = new Map<string, RuntimeApprovalLease>()
  // jun-10 HITL restructure — inline-interactive delegation. When the surface
  // declares `approvalProtocol.interactive`, a mid-turn ask is answered by the
  // SURFACE confirm that occupied the slot at scope entry (the live operator's
  // prompt) instead of the deferred mint+throw round-trip. The stack mirrors
  // `runWithProtocol` nesting: each scope pushes the confirm it displaced
  // (skipping self on nested scopes) and pops it on exit, so a side
  // conversation nested inside a turn still resolves to the outer operator.
  const interactive = base.approvalProtocol?.interactive === true
  const surfaceConfirms: Array<NonNullable<AgentConfig["onConfirm"]>> = []
  // Inline prompts SERIALIZE: one operator, one question on screen at a time.
  // Early-dispatched parallel calls (the `agent` fan-out) hit the gate
  // concurrently — without this chain the second prompt would clobber the
  // first on the single input channel (auto-deny). Each queued confirm
  // RE-CHECKS leases + session grants inside its critical section, so a
  // fan-out answered "[a]lways" prompts exactly once and the queued siblings
  // ride the just-minted grant.
  let inlineChain: Promise<unknown> = Promise.resolve()
  // EXPLICIT standing grants — minted ONLY when the operator answers with the
  // session verb (`{decision:"allow", scope:"session"}`, the CLI's "[a]lways
  // this session"). NOT the T03 H-1 leak class: H-1 was a single one-shot
  // approval silently auto-granting later turns; this grant exists only when
  // the operator explicitly chose the session scope, mirroring Claude Code's
  // "don't ask again this session". Keyed by the SAME shell-aware actionKey the
  // leases use (`bash|ls` never unlocks `bash|rm`); a SHELL_EXTRACT_FAILED key
  // is never granted (fail closed). Session-host lifetime (this controller is
  // minted once per session).
  const sessionGrants = new Set<string>()

  /** Claim AT MOST ONE unclaimed lease whose `actionKey` matches. The lookup +
   *  delete is synchronous (no `await` between find and consume) so two
   *  concurrent same-key `onConfirm` calls can never both claim the same lease —
   *  the second mints its own approval rather than racing the first (audit L5
   *  M-3). A `SHELL_EXTRACT_FAILED` action key never matches any lease ⇒ it
   *  always re-prompts (fail closed). */
  const claimLease = (
    actionKey: string | typeof SHELL_EXTRACT_FAILED,
  ): false | true | ConfirmDecision => {
    if (actionKey === SHELL_EXTRACT_FAILED) return false
    for (const [approvalId, lease] of leases) {
      if (lease.actionKey === actionKey) {
        leases.delete(approvalId)
        // ADR-0512 P3 — an ESCALATION lease carries the operator's rich decision
        // (allow_once / deny_and_steer); return it so the loop honours scope/steer.
        // A NORMAL lease has none ⇒ bare `true` (byte-identical grant).
        return lease.decision ?? true
      }
    }
    return false
  }

  const onConfirm: NonNullable<AgentConfig["onConfirm"]> = async (action) => {
    const actionKey = actionKeyOf(base.registry, action)
    const leased = claimLease(actionKey)
    if (leased !== false) return leased
    // Standing session grant (explicit operator "always" verb) — non-consuming.
    if (actionKey !== SHELL_EXTRACT_FAILED && sessionGrants.has(actionKey)) return true

    // Inline-interactive path: a live operator is bound to this scope — ask
    // them NOW, at the gate, and hand the (possibly rich) decision straight
    // back. No pending approval, no turn abort, no re-run. The deferred
    // mint+throw below remains for surfaces without an operator (web/SDK).
    const surface = surfaceConfirms[surfaceConfirms.length - 1]
    if (interactive && surface !== undefined) {
      const promptOperator = async (): Promise<Awaited<ReturnType<typeof surface>>> => {
        // Critical section — re-check: a confirm queued behind us may have just
        // minted the lease/grant this very key needs (the "[a]lways" fan-out).
        const leasedNow = claimLease(actionKey)
        if (leasedNow !== false) return leasedNow
        if (actionKey !== SHELL_EXTRACT_FAILED && sessionGrants.has(actionKey)) return true
        const raw = await surface(action)
        if (
          actionKey !== SHELL_EXTRACT_FAILED &&
          typeof raw === "object" &&
          raw !== null &&
          (raw as { decision?: unknown }).decision === "allow" &&
          (raw as { scope?: unknown }).scope === "session"
        ) {
          sessionGrants.add(actionKey)
        }
        return raw
      }
      const result = inlineChain.then(promptOperator, promptOperator)
      // Park the chain on settlement only — a deny/throw must not jam the queue.
      inlineChain = result.then(
        () => undefined,
        () => undefined,
      )
      return await result
    }

    const approval: PendingApprovalView = {
      approvalId: crypto.randomUUID(),
      reason: reasonOf(action),
      requestedAt: new Date().toISOString(),
      // ADR-0512 P3 — carry the skill-scope escalation context (if any) onto the
      // approval so the web/IDE surface renders the rich card. Omitted for a
      // normal confirm ⇒ byte-identical.
      ...escalationScopeFields(action),
    }
    // A throwing shell extraction has no stable key; record the sentinel string
    // form only for diagnostics — it can never match a future lease, and it is
    // marked non-grantable so a session-scoped approve can't stand on it.
    pending.set(approval.approvalId, {
      approval,
      actionKey:
        actionKey === SHELL_EXTRACT_FAILED ? `${action.tool}|<shell-extract-failed>` : actionKey,
      grantable: actionKey !== SHELL_EXTRACT_FAILED,
    })
    throw new RuntimeApprovalRequiredError(approval)
  }

  return {
    runWithProtocol: async <T>(work: () => Promise<T>): Promise<T> => {
      const slot = base.approvalProtocol?.confirmSlot
      if (slot === undefined) return await work()
      const previous = slot.current
      slot.current = onConfirm
      // Capture the displaced SURFACE confirm for inline delegation. A nested
      // scope displaces `onConfirm` itself — skip it so the stack top stays the
      // real operator prompt (or empty ⇒ deferred fail-closed).
      const pushedSurface = typeof previous === "function" && previous !== onConfirm
      if (pushedSurface) surfaceConfirms.push(previous)
      // Snapshot the leases present at scope entry; any of these still present
      // at scope exit were NOT consumed by this turn run and are stale — clear
      // them so an approval is good for exactly one turn (audit L5 H-1).
      const armedAtEntry = new Set(leases.keys())
      // Abandoned-approval drain (audit U2/#12): an approval that was ALREADY
      // pending when this scope began carries over the full turn. If it is STILL
      // pending at scope exit it was never resolved before the turn moved on —
      // the surface that held its `approvalId` is gone, so it can never be
      // matched and would otherwise leak in `pending` for the host's lifetime.
      // Snapshot at entry and drop the survivors in `finally`. The approval THIS
      // scope itself creates (when `onConfirm` throws) is added AFTER this
      // snapshot, so it gets a one-turn grace: it survives to its resolution, or
      // is drained by the NEXT scope if still unresolved. Mirrors the lease
      // drain above; no arbitrary cap, nesting-safe (each scope drains only what
      // it carried in).
      const pendingAtEntry = new Set(pending.keys())
      try {
        return await work()
      } finally {
        slot.current = previous
        if (pushedSurface) surfaceConfirms.pop()
        for (const approvalId of armedAtEntry) leases.delete(approvalId)
        for (const approvalId of pendingAtEntry) pending.delete(approvalId)
      }
    },
    resolveApproval: (
      approvalId: string,
      decision: "approve" | "deny",
      opts?: { readonly scope?: "once" | "session"; readonly steer?: string },
    ): void => {
      const record = pending.get(approvalId)
      if (record === undefined) return
      pending.delete(approvalId)
      // ADR-0512 P3 — an ESCALATION approval (the minted approval carried
      // `scopeContext`) resolves to a RICH `ConfirmDecision` so the surface's
      // 4-verb card is genuinely reachable: `allow_once` (scope:"once" ⇒ the
      // re-run dispatches WITHOUT widening), `deny_and_steer` (a RECOVERABLE
      // decline carrying the operator's corrective steer). A NORMAL approval has
      // no `scopeContext` ⇒ approve mints a plain `true` grant + deny mints NO
      // lease (the turn aborts), BYTE-IDENTICAL to the pre-ADR-0512 path.
      const isEscalation = record.approval.scopeContext !== undefined
      if (decision === "approve") {
        const leaseDecision: ConfirmDecision | undefined = isEscalation
          ? { decision: "allow", ...(opts?.scope !== undefined ? { scope: opts.scope } : {}) }
          : undefined
        leases.set(approvalId, {
          approvalId,
          actionKey: record.actionKey,
          ...(leaseDecision !== undefined ? { decision: leaseDecision } : {}),
        })
        // jun-10 — deferred "always" verb: a NORMAL approval resolved with the
        // EXPLICIT session scope additionally mints the standing grant (same
        // ledger the inline "[a]lways" uses), so a deferred surface (web card /
        // CLI fallback) pays the abort+re-run round-trip ONCE per key instead
        // of once per ask. Escalations are excluded: a session-scoped skill
        // widening is the skill-scope axis (the rich lease above), NOT a
        // tool-level never-ask-again. Non-grantable (shell-extract-failed)
        // records never stand (fail closed). Same consent semantics as the
        // inline path — the grant exists only on the operator's explicit verb.
        if (!isEscalation && opts?.scope === "session" && record.grantable) {
          sessionGrants.add(record.actionKey)
        }
        return
      }
      // decision === "deny". A normal deny sets no lease (unchanged). An
      // escalation deny sets a RECOVERABLE deny lease so the re-run produces the
      // `skill-scoped: declined`/`steered` tool_result (not a turn abort).
      if (!isEscalation) return
      const denyDecision: ConfirmDecision =
        opts?.steer !== undefined && opts.steer.trim().length > 0
          ? { decision: "deny_and_steer", steer: opts.steer }
          : { decision: "deny" }
      leases.set(approvalId, { approvalId, actionKey: record.actionKey, decision: denyDecision })
    },
    /** Test seam — never call in production. Exposes the live lease ledger so
     *  hellgates can assert turn-scoping without reaching into the closure. */
    onConfirm,
    /** Test seam — never call in production. Live size of the pending-approval
     *  map, so a hellgate can assert the abandoned-approval drain bounds it. */
    __pendingSize: (): number => pending.size,
  }
}

const createSideConversationBase = (args: {
  readonly base: RuntimeBase
  readonly registry: ToolRegistry
  readonly signal: AbortSignal
  readonly maxTurns: number
  readonly tally: UsageTally
}): RuntimeBase => {
  const {
    store: _store,
    embedder: _embedder,
    memory: _memory,
    metrics: _metrics,
    run: _run,
    subagent: _subagent,
    compactionBreaker: _compactionBreaker,
    verifyGuard: _verifyGuard,
    compaction: _compaction,
    workMetricsSink: _workMetricsSink,
    ...rest
  } = args.base

  return {
    ...rest,
    registry: args.registry,
    stream: createUsageTallyStream(args.base.stream, args.tally),
    maxTurns: args.maxTurns,
    signal: args.signal,
    sessionId: mintSideConversationSessionId(getSessionId(args.base)),
    planMode: false,
  }
}

const startSideConversation = async (args: {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
  readonly question: string
  readonly messages: readonly Message[]
  readonly signal: AbortSignal
  readonly inherit?: SessionHostSideConversationInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
}): Promise<SessionHostSideConversationResult> => {
  const inheritance = args.inherit ?? "system"
  const allowlist = args.tools ?? SIDE_CONVERSATION_DEFAULT_TOOLS
  const requestedTurns = args.maxTurns ?? 3
  const maxTurns = Math.max(1, Math.min(requestedTurns, SIDE_CONVERSATION_MAX_TURNS_CAP))
  const filteredRegistry = buildSideConversationRegistry(args.base.registry, allowlist)
  const inherited = buildSideConversationHistory(args.messages, inheritance)
  const userTurn: Message = {
    role: "user",
    content: [{ type: "text", text: args.question }],
  }
  const messages: Message[] = [...inherited, userTurn]
  const tally: UsageTally = { inputTokens: 0, outputTokens: 0 }
  const isolatedBase = createSideConversationBase({
    base: args.base,
    registry: filteredRegistry,
    signal: args.signal,
    maxTurns,
    tally,
  })
  const outcome = await runAgent(
    buildAgentConfigFromBase(
      buildAgentConfigFromBaseInput({
        base: isolatedBase,
        messages,
        signal: args.signal,
        turnAssembler: args.turnAssembler,
      }),
    ),
  )
  return {
    outcome,
    answerText: extractSideConversationAnswerText(outcome),
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    toolsAvailable: filteredRegistry.specs().length,
  }
}

interface RuntimeTurnResult {
  readonly outcome: AgentOutcome
  readonly messages: Message[]
  readonly approvalRequest?: PendingApprovalView
  readonly errorMessage?: string
}

const extractTurnErrorMessage = (event: AgentEvent): string | undefined =>
  event.type === "error" && event.message.length > 0 ? event.message : undefined

const toSessionHostTurnEvent = (event: AgentEvent): SessionHostTurnEvent | undefined => {
  switch (event.type) {
    case "assistant_text":
      return event.delta.length > 0
        ? { type: "assistant_text.delta", delta: event.delta }
        : undefined
    case "llm_request":
      return {
        type: "llm.request",
        model: event.model,
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.surfaceId !== undefined ? { surfaceId: event.surfaceId } : {}),
        ...(event.transportId !== undefined ? { transportId: event.transportId } : {}),
        ...(event.authMode !== undefined ? { authMode: event.authMode } : {}),
        ...(event.policy !== undefined ? { policy: event.policy } : {}),
      }
    case "llm_continuation":
      return {
        type: "llm.continuation",
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        surfaceId: event.surfaceId,
        transportId: event.transportId,
        phase: event.phase,
        mode: event.mode,
        reason: event.reason,
        ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      }
    case "tool_call":
      return {
        type: "tool.invoked",
        toolCallId: event.id,
        toolName: event.name,
        ...(event.input !== undefined ? { argsPreview: previewToolArgs(event.input) } : {}),
      }
    case "tool_result":
      return {
        type: "tool.completed",
        toolCallId: event.id,
        toolName: event.name,
        outcome: event.ok ? "ok" : "error",
        ...(event.preview !== undefined && event.preview.length > 0
          ? { resultPreview: clampPreview(event.preview) }
          : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }
    case "usage":
      return {
        type: "usage",
        promptTokens: event.inputTokens,
        completionTokens: event.outputTokens,
        totalTokens: event.inputTokens + event.outputTokens,
      }
    case "skill_scope_decision":
      // ADR-0512 — bridge the skill-scope decision SUMMARY onto the wire so the
      // web surface sees a hard-`blocked` / silently-declined out-of-scope tool
      // (these never reach the interactive `approval.requested` card). The CLI
      // already renders this off the `skill_scope_decision` STREAM event; this
      // gives the web the same one-line gray timeline note.
      return {
        type: "skill.scope.decision",
        tool: event.tool,
        activeSkill: event.activeSkill,
        decision: event.decision,
        isReadOnly: event.isReadOnly,
      }
    default:
      return undefined
  }
}

const createTurnStreamPort = (args: {
  readonly baseStream: AgentConfig["stream"]
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}): {
  readonly stream: AgentConfig["stream"]
  readonly getLastErrorMessage: () => string | undefined
} => {
  let lastErrorMessage: string | undefined
  return {
    stream: {
      emit(event: AgentEvent): void {
        const errorMessage = extractTurnErrorMessage(event)
        if (errorMessage !== undefined) lastErrorMessage = errorMessage
        const sessionEvent = toSessionHostTurnEvent(event)
        if (sessionEvent !== undefined) args.onEvent?.(sessionEvent)
        args.baseStream.emit(event)
      },
    },
    getLastErrorMessage: () => lastErrorMessage,
  }
}

const PREVIEW_MAX = 256

const clampPreview = (text: string): string =>
  text.length <= PREVIEW_MAX ? text : `${sliceWholeChars(text, PREVIEW_MAX - 1)}…`

const previewToolArgs = (input: unknown): string => {
  let serialised: string
  try {
    serialised = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return "<unserialisable>"
  }
  return clampPreview(serialised)
}

const buildRuntimeTurnArgs = (args: {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
  readonly history: readonly Message[]
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly signal?: AbortSignal
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}) => ({
  base: args.base,
  ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  history: [...args.history],
  prompt: args.prompt,
  ...(args.images !== undefined && args.images.length > 0 ? { images: [...args.images] } : {}),
  state: args.state,
  idMeta: args.idMeta,
  ...(args.signal !== undefined ? { signal: args.signal } : {}),
  ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
})

const toSessionHostTurnResult = (result: RuntimeTurnResult) =>
  result.approvalRequest !== undefined
    ? {
        outcome: result.outcome,
        messages: result.messages,
        approvalRequest: result.approvalRequest,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      }
    : {
        outcome: result.outcome,
        messages: result.messages,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      }

const runRuntimeTurn = async (args: {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
  readonly history: readonly Message[]
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly signal?: AbortSignal
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}): Promise<RuntimeTurnResult> => {
  const turnStream = createTurnStreamPort({
    baseStream: args.base.stream,
    ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
  })
  try {
    const content: ContentBlock[] = [{ type: "text", text: args.prompt }, ...(args.images ?? [])]
    const next = [...args.history, { role: "user", content } as Message]
    const outcome = await runAgent(
      buildAgentConfigFromBase(
        buildAgentConfigFromBaseInput({
          base: {
            ...args.base,
            stream: turnStream.stream,
          },
          messages: next,
          signal: args.signal,
          turnAssembler: args.turnAssembler,
        }),
      ),
    )
    const messages = outcome.messages
    const errorMessage = turnStream.getLastErrorMessage()
    await persistTurn({
      state: args.state,
      idMeta: args.idMeta,
      sessionId: getSessionId(args.base),
      messages,
      outcome,
    })
    return {
      outcome,
      messages,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    }
  } catch (error) {
    if (isRuntimeApprovalRequiredError(error)) {
      return {
        outcome: approvalPlaceholderOutcome(args.history),
        messages: [...args.history],
        approvalRequest: error.approval,
      }
    }
    throw error
  }
}

/** Live-host refcount shared by every session host minted from ONE facade.
 *  The shared session-scoped resources (MCP fleet, memory-auto wires, the
 *  bootstrap shutdown hook) are torn down by the LAST close, never the first —
 *  so a future multi-session facade cannot have session A's close strand
 *  session B's MCP tools. Every live surface today is 1-session-per-facade,
 *  where this is byte-identical (first close == last close). */
export interface SessionHostFleet {
  live: number
}

const createRuntimeSessionHost = (args: {
  readonly state: RuntimeContextBindingState
  readonly options: CreateRuntimeContextHostArgs
  readonly fleet: SessionHostFleet
}): SessionHost => {
  let closed = false
  let shutdownComplete = false
  const base = args.state.base
  const approvalProtocol = createRuntimeApprovalProtocolController(base)
  const capabilityManifest = buildCapabilityManifest(base)

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    closed = true
    // Last-close-wins: siblings minted from the same facade still hold the
    // shared resources below — defer the teardown to whichever closes last.
    args.fleet.live -= 1
    if (args.fleet.live > 0) return
    // Deferred consolidation drain — the per-turn Phase-1 distill runs on a
    // background lane (so it never blocks turn completion); a run kicked off
    // by the LAST turn may still be in flight here. Await it BEFORE the WAL
    // dispose below, or the distill's store write lands on a closed handle.
    // Best-effort: a drain failure must not block session teardown.
    try {
      await base.memoryAutoDrain?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // U7-10: release the memory-auto bun:sqlite WAL handle for this session
    // BEFORE the broader shutdown. Idempotent + best-effort: a dispose throw
    // must not block session teardown.
    try {
      base.memoryAutoDispose?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // H16 — fire the cross-session auto-dream pass at session end (default-OFF:
    // no-op unless QUANTA_AUTO_DREAM=1 wired a trigger). Best-effort + the
    // trigger itself swallows its own failures; we additionally guard here so a
    // dream error never blocks the broader shutdown.
    try {
      await base.dreamOnSessionEnd?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // Session-scoped MCP teardown. These clients live for the WHOLE session —
    // the per-turn `runRuntimeTurn` finally that used to stop them was a
    // one-shot relic: it killed the fleet at the end of turn 1 (every later
    // turn's MCP tools hit a stopped client) and put a serial, potentially
    // unbounded shutdown wait on the turn-completion critical path. Stopped
    // here instead, BEFORE `options.shutdown()` so a bootstrap-owned shutdown
    // (stop clients → close egress proxy) keeps its ordering — `client.stop()`
    // is idempotent, so the double-stop is a no-op.
    for (const client of args.options.mcpClients ?? []) {
      await client.stop().catch(() => undefined)
    }
    await args.options.shutdown()
  }

  return {
    describe: () => ({
      sessionId: base.sessionId ?? crypto.randomUUID(),
      permissionMode: base.permission.mode,
      capabilityManifest,
      ...(args.options.boot?.identityModeState !== undefined
        ? { identityMode: args.options.boot.identityModeState.get() }
        : {}),
      ...(args.options.boot?.toolProfileState !== undefined
        ? { toolProfile: args.options.boot.toolProfileState.get() }
        : {}),
      messages: [...args.options.history],
      // Expose the LLM port's model slug so the kernel can carry it onto
      // `session.created` + `turn.completed`. Optional — adapters without
      // a `model` field just leave it undefined.
      ...(base.llm.model !== undefined ? { modelSlug: base.llm.model } : {}),
    }),
    runTurn: async ({ history, prompt, images, signal, onEvent }) => {
      if (closed) throw new Error("runtime session host is closed")
      const result = await approvalProtocol.runWithProtocol(
        async () =>
          await runRuntimeTurn(
            buildRuntimeTurnArgs({
              base,
              ...(args.state.turnAssembler !== undefined
                ? { turnAssembler: args.state.turnAssembler }
                : {}),
              history,
              prompt,
              ...(images !== undefined ? { images } : {}),
              state: args.options.state,
              idMeta: args.options.idMeta,
              ...(signal !== undefined ? { signal } : {}),
              ...(onEvent !== undefined ? { onEvent } : {}),
            }),
          ),
      )
      return toSessionHostTurnResult(result)
    },
    resolveApproval: async ({ approvalId, decision, scope, steer }) => {
      // ADR-0512 P3 — forward the escalation's once/session scope + corrective
      // steer so the lease can carry the operator's rich decision. Both are
      // `undefined` for a normal approval ⇒ byte-identical grant.
      approvalProtocol.resolveApproval(approvalId, decision, {
        ...(scope !== undefined ? { scope } : {}),
        ...(steer !== undefined ? { steer } : {}),
      })
    },
    setIdentityMode: async (mode) => {
      args.options.boot?.identityModeState?.set(mode as never)
      args.options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      args.options.boot?.toolProfileState?.set(profile as never)
    },
    setPermissionMode: async (mode) => {
      // Fail-closed: only a KNOWN PermissionMode reaches the gate. An unknown
      // string would make `modePolicy[mode]` undefined downstream, so we ignore
      // it (keep the current mode) rather than poison the gate.
      if (!isPermissionMode(mode)) return
      // Mutate the session's permission context in place. When the surface wired
      // a LIVE getter/setter proxy for `permission.mode` (web daemon /
      // bootstrap), the per-turn gate reads the new value on the NEXT turn — a
      // real mid-session switch, not a display-only echo. On a plain
      // `PermissionContext` the property is writable too, so this is a safe
      // no-surprise assignment.
      base.permission.mode = mode
    },
    startSideConversation: async (
      sideArgs: SessionHostSideConversationArgs,
    ): Promise<SessionHostSideConversationResult> =>
      await startSideConversation({
        base,
        ...(args.state.turnAssembler !== undefined
          ? { turnAssembler: args.state.turnAssembler }
          : {}),
        question: sideArgs.question,
        messages: sideArgs.messages,
        signal: sideArgs.signal,
        ...(sideArgs.inherit !== undefined ? { inherit: sideArgs.inherit } : {}),
        ...(sideArgs.tools !== undefined ? { tools: sideArgs.tools } : {}),
        ...(sideArgs.maxTurns !== undefined ? { maxTurns: sideArgs.maxTurns } : {}),
      }),
    close,
  }
}

const createRuntimeContextBinding = (state: RuntimeContextBindingState): RuntimeContextBinding => {
  const normalizedState: RuntimeContextBindingState = {
    ...state,
    base: ensureSessionId(state.base),
  }
  return {
    snapshot: buildSnapshot(normalizedState.base),
    patch: (patch) =>
      createRuntimeContextBinding({
        base: sanitizeRuntimeBase({
          ...normalizedState.base,
          ...patch,
        }),
        ...(normalizedState.turnAssembler !== undefined
          ? { turnAssembler: normalizedState.turnAssembler }
          : {}),
      }),
    createRuntimeHost: (options) => {
      // One refcount per facade: every session host minted below shares the
      // session-scoped resources on `options`/`base`, so the LAST close owns
      // the shared teardown (see {@link SessionHostFleet}).
      const fleet: SessionHostFleet = { live: 0 }
      return createSingleSessionRuntimeHost((_config: RuntimeSessionConfig) => {
        fleet.live += 1
        return createRuntimeSessionHost({
          state: normalizedState,
          options,
          fleet,
        })
      })
    },
    materializeReviewerAgent: (boot, turnAssembler) =>
      boot.materializeReviewerAgent(
        buildAgentConfigFromBase(
          buildAgentConfigFromBaseInput({
            base: normalizedState.base,
            messages: [],
            signal: normalizedState.base.signal,
            turnAssembler: turnAssembler ?? normalizedState.turnAssembler,
          }),
        ),
      ),
  }
}

export const createRuntimeContextBindingFromAgentConfigBase = (args: {
  readonly base: RuntimeAgentConfigBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}): RuntimeContextBinding =>
  createRuntimeContextBinding({
    base: wireRuntimePorts(ensureSessionId(args.base as RuntimeBase)),
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })

export const createRuntimeContextBindingFromBootstrap = async (
  args: CreateRuntimeContextBindingFromBootstrapArgs,
): Promise<RuntimeContextBinding> => {
  if (
    args.overlay?.admissibility !== undefined &&
    args.overlay.admissibilityBuilder !== undefined
  ) {
    throw new Error(
      "runtime bootstrap overlay cannot set both admissibility and admissibilityBuilder",
    )
  }
  let base = buildBaseFromBootstrap({
    boot: args.boot,
    stream: args.stream,
    onConfirm: args.onConfirm,
    ...(args.includeSearchPipeline !== undefined
      ? { includeSearchPipeline: args.includeSearchPipeline }
      : {}),
    ...(args.overlay !== undefined ? { overlay: args.overlay } : {}),
  })

  if (args.execution !== undefined) {
    base = await extendBaseWithExecutionPlane({
      ...args.execution,
      base,
      ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
    })
  }

  if (args.memoryAuto !== undefined) {
    base = await extendBaseWithMemoryAuto({
      ...args.memoryAuto,
      base,
    })
  }

  if (args.overlay?.admissibilityBuilder !== undefined) {
    const preview = createRuntimeContextBinding({
      base,
      ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
    })
    const admissibility = await args.overlay.admissibilityBuilder({
      materializeReviewerAgent: (boot, turnAssembler) =>
        preview.materializeReviewerAgent(boot, turnAssembler),
    })
    if (admissibility !== undefined) {
      base = {
        ...base,
        admissibility,
      }
    }
  }

  return createRuntimeContextBinding({
    base: wireRuntimePorts(base),
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
}

/** T03 — test seam. Exposes the otherwise module-private approval-lease
 *  controller so grant-isolation hellgates can drive it directly (turn-scoping,
 *  concurrent same-key actions, fail-closed shell extraction) without standing
 *  up a whole runtime host. NOT part of the production API surface. */
export const __testing = {
  createRuntimeApprovalProtocolController,
}

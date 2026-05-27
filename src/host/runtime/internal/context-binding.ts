import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationInheritance,
  SessionHostSideConversationResult,
  SessionHostTurnEvent,
} from "@/kernel/session"
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ResponsesContinuationStore,
} from "@/llm"
import { inferReviewKind, reasonCodeFor, type ToolAction } from "@/permission"
import type { CapabilityManifest, PendingApprovalView } from "@/protocol/session"
import type {
  IdentityModeSessionState,
  SystemSource,
  ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import { persistTurn } from "@/runner/orchestrate/persist-turn"
import { buildSharedExecutionPlaneRuntimeAugments } from "@/runner/session-execution-plane"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import type { AgentEvent } from "@/stream"
import { automationUpdateTool, type Tool, ToolRegistry } from "@/tool"
import { createSingleSessionRuntimeHost } from "../builder"
import { deriveCapabilityManifest } from "../capabilities"
import type { RuntimeHost, RuntimeSessionConfig } from "../types"

type RuntimeBase = RuntimeAgentConfigBase & {
  approvalProtocol?: RuntimeApprovalProtocolConfig
  systemSource?: SystemSource
  toolProfileState?: ToolProfileSessionState
  identityModeState?: IdentityModeSessionState
}

interface RuntimeConfirmSlot {
  current: NonNullable<AgentConfig["onConfirm"]>
}

interface RuntimeApprovalProtocolConfig {
  readonly confirmSlot: RuntimeConfirmSlot
}

interface BootBindings {
  readonly mode: SessionBootstrapResult["mode"]
  readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
  readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
  readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
}

interface RuntimeAssemblerContext {
  readonly llm: AgentConfig["llm"]
  readonly registry: AgentConfig["registry"]
  readonly stream: AgentConfig["stream"]
  readonly permission: AgentConfig["permission"]
  readonly system: string
  readonly systemSource?: SystemSource
  readonly cwd: string
  readonly maxTurns: number
  readonly signal: AbortSignal
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  readonly store: AgentConfig["store"]
  readonly sessionId: string
  readonly embedder: AgentConfig["embedder"]
  readonly memoryConfig: AgentConfig["memory"]
  readonly planMode: boolean
  readonly metrics: AgentConfig["metrics"]
  readonly run: AgentConfig["run"]
  readonly subagentConfig: AgentConfig["subagent"]
  readonly skillsConfig: AgentConfig["skills"]
  readonly compactionBreakerConfig: AgentConfig["compactionBreaker"]
  readonly verifyGuardConfig: AgentConfig["verifyGuard"]
  readonly summarizerLlm?: NonNullable<AgentConfig["compaction"]>["summarizerLlm"]
  readonly onShellEvent: AgentConfig["onShellEvent"]
  readonly workMetricsSink: AgentConfig["workMetricsSink"]
  readonly followUpQueue: AgentConfig["followUpQueue"]
  readonly planStore: AgentConfig["planStore"]
  readonly retrievalStack: AgentConfig["retrievalStack"]
  readonly searchPipeline: AgentConfig["searchPipeline"]
  readonly memoryConsolidator: AgentConfig["memoryConsolidator"]
  readonly sessionCtx: AgentConfig["sessionCtx"]
  readonly delegation: AgentConfig["delegation"]
  readonly subagentBackground: AgentConfig["subagentBackground"]
  readonly autoBackground: AgentConfig["autoBackground"]
  readonly fork: AgentConfig["fork"]
  readonly forkSession: AgentConfig["forkSession"]
  readonly conversationCheckpoint: AgentConfig["conversationCheckpoint"]
  readonly responsesContinuation: AgentConfig["responsesContinuation"]
  readonly stage1OutputsStore: AgentConfig["stage1OutputsStore"]
  readonly automationEngine: AgentConfig["automationEngine"]
  readonly admissibility: AgentConfig["admissibility"]
  readonly planExitPort: AgentConfig["planExitPort"]
  readonly userInputPort: AgentConfig["userInputPort"]
  readonly toolProfileState?: ToolProfileSessionState
  readonly identityModeState?: IdentityModeSessionState
  readonly focusChain: AgentConfig["focusChain"]
  readonly shellSnapshot: AgentConfig["shellSnapshot"]
  readonly sessionEffort: AgentConfig["sessionEffort"]
  readonly decisionEmitter: AgentConfig["decisionEmitter"]
  readonly granularRegistry: AgentConfig["granularRegistry"]
}

interface RuntimeContextSnapshot {
  readonly registry: AgentConfig["registry"]
  readonly permission: AgentConfig["permission"]
  readonly systemSource?: SystemSource
  readonly automationEngine?: AgentConfig["automationEngine"]
  readonly toolProfileState?: ToolProfileSessionState
  readonly identityModeState?: IdentityModeSessionState
  readonly focusChain?: AgentConfig["focusChain"]
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

const buildAssemblerContext = (
  base: RuntimeBase,
  signal: AbortSignal | undefined,
): RuntimeAssemblerContext => ({
  llm: base.llm,
  registry: base.registry,
  stream: base.stream,
  permission: base.permission,
  system: base.system,
  ...(base.systemSource !== undefined ? { systemSource: base.systemSource } : {}),
  cwd: base.cwd,
  maxTurns: base.maxTurns,
  signal: signal ?? base.signal,
  onConfirm: base.onConfirm ?? (async () => false),
  store: base.store,
  sessionId: base.sessionId ?? crypto.randomUUID(),
  embedder: base.embedder,
  memoryConfig: base.memory,
  planMode: base.planMode === true,
  metrics: base.metrics,
  run: base.run,
  subagentConfig: base.subagent,
  skillsConfig: base.skills,
  compactionBreakerConfig: base.compactionBreaker,
  verifyGuardConfig: base.verifyGuard,
  ...(base.compaction?.summarizerLlm !== undefined
    ? { summarizerLlm: base.compaction.summarizerLlm }
    : {}),
  onShellEvent: base.onShellEvent,
  workMetricsSink: base.workMetricsSink,
  followUpQueue: base.followUpQueue,
  planStore: base.planStore,
  retrievalStack: base.retrievalStack,
  searchPipeline: base.searchPipeline,
  memoryConsolidator: base.memoryConsolidator,
  sessionCtx: base.sessionCtx,
  delegation: base.delegation,
  subagentBackground: base.subagentBackground,
  autoBackground: base.autoBackground,
  fork: base.fork,
  forkSession: base.forkSession,
  conversationCheckpoint: base.conversationCheckpoint,
  responsesContinuation: base.responsesContinuation,
  stage1OutputsStore: base.stage1OutputsStore,
  automationEngine: base.automationEngine,
  admissibility: base.admissibility,
  planExitPort: base.planExitPort,
  userInputPort: base.userInputPort,
  ...(base.toolProfileState !== undefined ? { toolProfileState: base.toolProfileState } : {}),
  ...(base.identityModeState !== undefined ? { identityModeState: base.identityModeState } : {}),
  focusChain: base.focusChain,
  shellSnapshot: base.shellSnapshot,
  sessionEffort: base.sessionEffort,
  decisionEmitter: base.decisionEmitter,
  granularRegistry: base.granularRegistry,
})

const buildAgentConfigFromBase = (args: {
  readonly base: RuntimeBase
  readonly messages: readonly Message[]
  readonly signal?: AbortSignal
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}): AgentConfig => {
  if (args.turnAssembler !== undefined) {
    return args.turnAssembler([...args.messages], buildAssemblerContext(args.base, args.signal))
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

  return {
    ...(rest as Omit<AgentConfig, "messages" | "signal" | "system">),
    messages: [...args.messages],
    system: systemSource?.get() ?? system,
    signal: args.signal ?? args.base.signal,
    ...toToolProfileConfig(toolProfileState),
    ...toIdentityModeConfig(identityModeState),
  }
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
    ...whenDefined(
      "searchPipeline",
      args.includeSearchPipeline === true ? args.boot.tooling.searchPipeline : undefined,
    ),
    ...whenDefined("approvalProtocol", args.overlay?.approvalProtocol),
    ...whenDefined("planExitPort", args.overlay?.planExitPort),
    ...whenDefined("userInputPort", args.overlay?.userInputPort),
    ...whenDefined("toolProfileState", args.boot.toolProfileState),
    ...whenDefined("identityModeState", args.boot.identityModeState),
    ...whenDefined("focusChain", args.boot.focusChain),
    ...whenDefined("onShellEvent", args.boot.onShellEvent),
    ...whenDefined("workMetricsSink", args.boot.workMetricsSink),
    ...whenDefined("followUpQueue", args.boot.lifecycleFollowUpQueue),
    ...whenDefined("planStore", args.boot.planStore),
    ...whenDefined("decisionEmitter", args.overlay?.decisionEmitter),
    ...whenDefined("admissibility", args.overlay?.admissibility),
    ...whenDefined("shellSnapshot", args.overlay?.shellSnapshot),
    ...whenDefined("sessionConfigPort", args.boot.sessionConfigPort),
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
  return {
    ...args.base,
    ...(auto.sessionCtx !== undefined ? { sessionCtx: auto.sessionCtx } : {}),
    stage1OutputsStore: auto.stage1OutputsStore,
    memoryConsolidator: auto.memoryConsolidator,
  }
}

const buildOptionalSnapshotFields = (
  base: RuntimeBase,
): Partial<Omit<RuntimeContextSnapshot, "registry" | "permission">> => ({
  ...whenDefined("systemSource", base.systemSource),
  ...whenDefined("automationEngine", base.automationEngine),
  ...whenDefined("toolProfileState", base.toolProfileState),
  ...whenDefined("identityModeState", base.identityModeState),
  ...whenDefined("focusChain", base.focusChain),
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

class RuntimeApprovalRequiredError extends Error {
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
}

const actionKeyOf = (registry: ToolRegistry, action: ToolAction): string => {
  let shellCommand: string | null
  try {
    shellCommand = registry.extractShellCommand(action.tool, action.input)
  } catch {
    shellCommand = null
  }
  return shellCommand !== null ? `${action.tool}|${shellCommand}` : action.tool
}

const reasonOf = (action: ToolAction): PendingApprovalView["reason"] =>
  reasonCodeFor(inferReviewKind(action.tool, action.isReadOnly))

const approvalPlaceholderOutcome = (messages: readonly Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})

const createRuntimeApprovalProtocolController = (base: RuntimeBase) => {
  const pending = new Map<string, PendingRuntimeApprovalRecord>()
  const grants = new Set<string>()

  const onConfirm: NonNullable<AgentConfig["onConfirm"]> = async (action) => {
    const actionKey = actionKeyOf(base.registry, action)
    if (grants.delete(actionKey)) return true

    const approval: PendingApprovalView = {
      approvalId: crypto.randomUUID(),
      reason: reasonOf(action),
      requestedAt: new Date().toISOString(),
    }
    pending.set(approval.approvalId, { approval, actionKey })
    throw new RuntimeApprovalRequiredError(approval)
  }

  return {
    runWithProtocol: async <T>(work: () => Promise<T>): Promise<T> => {
      const slot = base.approvalProtocol?.confirmSlot
      if (slot === undefined) return await work()
      const previous = slot.current
      slot.current = onConfirm
      try {
        return await work()
      } finally {
        slot.current = previous
      }
    },
    resolveApproval: (approvalId: string, decision: "approve" | "deny"): void => {
      const record = pending.get(approvalId)
      if (record === undefined) return
      pending.delete(approvalId)
      if (decision === "approve") grants.add(record.actionKey)
    },
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
  text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX - 1)}…`

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
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
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
  ...(args.mcpClients !== undefined ? { mcpClients: args.mcpClients } : {}),
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
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
  readonly signal?: AbortSignal
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}): Promise<RuntimeTurnResult> => {
  const mcpClients = args.mcpClients ?? []
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
  } finally {
    for (const client of mcpClients) await client.stop().catch(() => undefined)
  }
}

const createRuntimeSessionHost = (args: {
  readonly state: RuntimeContextBindingState
  readonly options: CreateRuntimeContextHostArgs
}): SessionHost => {
  let closed = false
  let shutdownComplete = false
  const base = args.state.base
  const approvalProtocol = createRuntimeApprovalProtocolController(base)
  const capabilityManifest = buildCapabilityManifest(base)

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    await args.options.shutdown()
    closed = true
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
              ...(args.options.mcpClients !== undefined
                ? { mcpClients: args.options.mcpClients }
                : {}),
              ...(signal !== undefined ? { signal } : {}),
              ...(onEvent !== undefined ? { onEvent } : {}),
            }),
          ),
      )
      return toSessionHostTurnResult(result)
    },
    resolveApproval: async ({ approvalId, decision }) => {
      approvalProtocol.resolveApproval(approvalId, decision)
    },
    setIdentityMode: async (mode) => {
      args.options.boot?.identityModeState?.set(mode as never)
      args.options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      args.options.boot?.toolProfileState?.set(profile as never)
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
    createRuntimeHost: (options) =>
      createSingleSessionRuntimeHost((_config: RuntimeSessionConfig) =>
        createRuntimeSessionHost({
          state: normalizedState,
          options,
        }),
      ),
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
    base: ensureSessionId(args.base as RuntimeBase),
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
    base,
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
}

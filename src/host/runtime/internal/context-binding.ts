import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationInheritance,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import { type CapabilityManifest, normalizeCapabilityManifest } from "@/protocol/session"
import {
  type IdentityModeSessionState,
  type SystemSource,
  type ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import { persistTurn } from "@/runner/orchestrate/persist-turn"
import { buildSharedExecutionPlaneRuntimeAugments } from "@/runner/session-execution-plane"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import { ToolRegistry, type Tool } from "@/tool"
import { createSingleSessionRuntimeHost } from "../builder"
import type { RuntimeHost, RuntimeSessionConfig } from "../types"

type RuntimeBase = RuntimeAgentConfigBase & {
  systemSource?: SystemSource
  toolProfileState?: ToolProfileSessionState
  identityModeState?: IdentityModeSessionState
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
  readonly admissibility?: AgentConfig["admissibility"]
  readonly decisionEmitter?: AgentConfig["decisionEmitter"]
  readonly planExitPort?: AgentConfig["planExitPort"]
  readonly shellSnapshot?: AgentConfig["shellSnapshot"]
  readonly summarizerLlm?: NonNullable<AgentConfig["compaction"]>["summarizerLlm"]
  readonly userInputPort?: AgentConfig["userInputPort"]
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

const ensureSessionId = (base: RuntimeBase): RuntimeBase =>
  base.sessionId === undefined ? { ...base, sessionId: crypto.randomUUID() } : base

const buildCapabilityManifest = (base: RuntimeBase): CapabilityManifest =>
  normalizeCapabilityManifest({
    approvals: "operator",
    tools: base.registry.all().length > 0,
    memory:
      base.store !== undefined || base.memoryConsolidator !== undefined || base.memory !== undefined,
    artifacts: true,
    subagents:
      base.subagent !== undefined ||
      base.delegation !== undefined ||
      base.subagentBackground !== undefined,
    automation: base.automationEngine !== undefined,
    shellSnapshot: base.shellSnapshot !== undefined,
    transport: "inproc",
  })

const toToolProfileConfig = (
  state: ToolProfileSessionState | undefined,
): Partial<AgentConfig> =>
  state === undefined
    ? {}
    : {
        toolProfile: {
          resolver: state.resolver,
          ...(state.defaultName !== undefined ? { defaultName: state.defaultName } : {}),
          activeName: () => state.get() ?? state.defaultName ?? "write",
        },
      }

const toIdentityModeConfig = (
  state: IdentityModeSessionState | undefined,
): Partial<AgentConfig> =>
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
    return args.turnAssembler(
      [...args.messages],
      buildAssemblerContext(args.base, args.signal),
    )
  }

  const {
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

const buildCompactionConfig = (args: {
  readonly store: AgentConfig["store"]
  readonly summarizerLlm?: NonNullable<AgentConfig["compaction"]>["summarizerLlm"]
}): AgentConfig["compaction"] | undefined => {
  if (args.store === undefined && args.summarizerLlm === undefined) return undefined
  return args.summarizerLlm !== undefined ? { summarizerLlm: args.summarizerLlm } : {}
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
    registry: args.boot.tooling.registry,
    stream: args.stream,
    permission: args.boot.permission,
    messages: [...args.boot.history],
    system: args.boot.system,
    ...(args.boot.systemSource !== undefined ? { systemSource: args.boot.systemSource } : {}),
    cwd: args.boot.cwd,
    maxTurns: args.boot.maxTurns,
    signal: args.boot.abort.signal,
    onConfirm: args.onConfirm,
    sessionId: args.boot.sessionId,
    ...(args.boot.tooling.store !== undefined ? { store: args.boot.tooling.store } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(args.boot.tooling.embedder !== undefined ? { embedder: args.boot.tooling.embedder } : {}),
    ...(args.boot.tooling.memoryConfig !== undefined
      ? { memory: args.boot.tooling.memoryConfig }
      : {}),
    ...(args.boot.features.planMode ? { planMode: true } : {}),
    ...(args.boot.features.metrics !== undefined ? { metrics: args.boot.features.metrics } : {}),
    ...(args.boot.run !== undefined ? { run: args.boot.run } : {}),
    ...(args.boot.tooling.subagentConfig !== undefined
      ? { subagent: args.boot.tooling.subagentConfig }
      : {}),
    ...(args.boot.tooling.skillsConfig !== undefined
      ? { skills: args.boot.tooling.skillsConfig }
      : {}),
    ...(args.boot.tooling.compactionBreakerConfig !== undefined
      ? { compactionBreaker: args.boot.tooling.compactionBreakerConfig }
      : {}),
    ...(args.boot.tooling.verifyGuardConfig !== undefined
      ? { verifyGuard: args.boot.tooling.verifyGuardConfig }
      : {}),
    ...(args.includeSearchPipeline === true && args.boot.tooling.searchPipeline !== undefined
      ? { searchPipeline: args.boot.tooling.searchPipeline }
      : {}),
    ...(args.overlay?.planExitPort !== undefined
      ? { planExitPort: args.overlay.planExitPort }
      : {}),
    ...(args.overlay?.userInputPort !== undefined
      ? { userInputPort: args.overlay.userInputPort }
      : {}),
    ...(args.boot.toolProfileState !== undefined
      ? { toolProfileState: args.boot.toolProfileState }
      : {}),
    ...(args.boot.identityModeState !== undefined
      ? { identityModeState: args.boot.identityModeState }
      : {}),
    ...(args.boot.focusChain !== undefined ? { focusChain: args.boot.focusChain } : {}),
    ...(args.boot.onShellEvent !== undefined ? { onShellEvent: args.boot.onShellEvent } : {}),
    ...(args.boot.workMetricsSink !== undefined
      ? { workMetricsSink: args.boot.workMetricsSink }
      : {}),
    ...(args.boot.lifecycleFollowUpQueue !== undefined
      ? { followUpQueue: args.boot.lifecycleFollowUpQueue }
      : {}),
    ...(args.boot.planStore !== undefined ? { planStore: args.boot.planStore } : {}),
    ...(args.overlay?.decisionEmitter !== undefined
      ? { decisionEmitter: args.overlay.decisionEmitter }
      : {}),
    ...(args.overlay?.admissibility !== undefined
      ? { admissibility: args.overlay.admissibility }
      : {}),
    ...(args.overlay?.shellSnapshot !== undefined
      ? { shellSnapshot: args.overlay.shellSnapshot }
      : {}),
    sessionEffort: () => args.boot.effortStore.get(),
  })
}

const extendBaseWithExecutionPlane = async (
  args: RuntimeExecutionComposeArgs,
): Promise<RuntimeBase> => {
  const parentConfig = buildAgentConfigFromBase({
    base: args.base,
    messages: [...args.history],
    signal: args.base.signal,
    turnAssembler: args.turnAssembler,
  })
  const augments = await buildSharedExecutionPlaneRuntimeAugments({
    history: args.history,
    parentConfig,
    subagentConfig: args.base.subagent,
    cwd: args.cwd,
    envSource: args.envSource,
    ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
  })
  return { ...args.base, ...augments }
}

const extendBaseWithMemoryAuto = async (args: RuntimeMemoryAutoComposeArgs): Promise<RuntimeBase> => {
  const auto = await buildSessionMemoryAutoWires({
    env: args.env,
    llm: args.base.llm,
    summarizerLlm: args.base.compaction?.summarizerLlm,
    sessionId: args.base.sessionId ?? crypto.randomUUID(),
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

const buildSnapshot = (base: RuntimeBase): RuntimeContextSnapshot => ({
  registry: base.registry,
  permission: base.permission,
  ...(base.systemSource !== undefined ? { systemSource: base.systemSource } : {}),
  ...(base.automationEngine !== undefined ? { automationEngine: base.automationEngine } : {}),
  ...(base.toolProfileState !== undefined ? { toolProfileState: base.toolProfileState } : {}),
  ...(base.identityModeState !== undefined
    ? { identityModeState: base.identityModeState }
    : {}),
  ...(base.focusChain !== undefined ? { focusChain: base.focusChain } : {}),
  ...(base.decisionEmitter !== undefined ? { decisionEmitter: base.decisionEmitter } : {}),
  ...(base.admissibility !== undefined ? { admissibility: base.admissibility } : {}),
  ...(base.planExitPort !== undefined ? { planExitPort: base.planExitPort } : {}),
  ...(base.userInputPort !== undefined ? { userInputPort: base.userInputPort } : {}),
  ...(base.conversationCheckpoint !== undefined
    ? { conversationCheckpoint: base.conversationCheckpoint }
    : {}),
  ...(base.fork !== undefined ? { fork: base.fork } : {}),
  ...(base.forkSession !== undefined ? { forkSession: base.forkSession } : {}),
  ...(base.delegation !== undefined ? { delegation: base.delegation } : {}),
  ...(base.subagentBackground !== undefined
    ? { subagentBackground: base.subagentBackground }
    : {}),
  ...(base.autoBackground !== undefined ? { autoBackground: base.autoBackground } : {}),
  ...(base.sessionCtx !== undefined ? { sessionCtx: base.sessionCtx } : {}),
  ...(base.stage1OutputsStore !== undefined
    ? { stage1OutputsStore: base.stage1OutputsStore }
    : {}),
  ...(base.memoryConsolidator !== undefined
    ? { memoryConsolidator: base.memoryConsolidator }
    : {}),
  ...(base.granularRegistry !== undefined ? { granularRegistry: base.granularRegistry } : {}),
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

const createSideConversationBase = (args: {
  readonly base: RuntimeBase
  readonly registry: ToolRegistry
  readonly signal: AbortSignal
  readonly maxTurns: number
  readonly tally: UsageTally
}): RuntimeBase => ({
  ...args.base,
  registry: args.registry,
  stream: createUsageTallyStream(args.base.stream, args.tally),
  maxTurns: args.maxTurns,
  signal: args.signal,
  store: undefined,
  sessionId: mintSideConversationSessionId(args.base.sessionId ?? crypto.randomUUID()),
  embedder: undefined,
  memory: undefined,
  metrics: undefined,
  run: undefined,
  subagent: undefined,
  compactionBreaker: undefined,
  verifyGuard: undefined,
  compaction: undefined,
  workMetricsSink: undefined,
  planMode: false,
})

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
    buildAgentConfigFromBase({
      base: isolatedBase,
      messages,
      signal: args.signal,
      turnAssembler: args.turnAssembler,
    }),
  )
  return {
    outcome,
    answerText: extractSideConversationAnswerText(outcome),
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    toolsAvailable: filteredRegistry.specs().length,
  }
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
}): Promise<{ readonly outcome: AgentOutcome; readonly messages: Message[] }> => {
  const mcpClients = args.mcpClients ?? []
  try {
    const content: ContentBlock[] = [{ type: "text", text: args.prompt }, ...(args.images ?? [])]
    const next = [...args.history, { role: "user", content } as Message]
    const outcome = await runAgent(
      buildAgentConfigFromBase({
        base: args.base,
        messages: next,
        signal: args.signal,
        turnAssembler: args.turnAssembler,
      }),
    )
    const messages = outcome.messages
    await persistTurn({
      state: args.state,
      idMeta: args.idMeta,
      sessionId: args.base.sessionId,
      messages,
      outcome,
    })
    return { outcome, messages }
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
    }),
    runTurn: async ({ history, prompt, images, signal }) => {
      if (closed) throw new Error("runtime session host is closed")
      const result = await runRuntimeTurn({
        base,
        ...(args.state.turnAssembler !== undefined
          ? { turnAssembler: args.state.turnAssembler }
          : {}),
        history: [...history],
        prompt,
        ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
        state: args.options.state,
        idMeta: args.options.idMeta,
        ...(args.options.mcpClients !== undefined ? { mcpClients: args.options.mcpClients } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      return { outcome: result.outcome, messages: result.messages }
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
        base: {
          ...normalizedState.base,
          ...patch,
        },
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
        buildAgentConfigFromBase({
          base: normalizedState.base,
          messages: [],
          signal: normalizedState.base.signal,
          turnAssembler: turnAssembler ?? normalizedState.turnAssembler,
        }),
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

  return createRuntimeContextBinding({
    base,
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
}

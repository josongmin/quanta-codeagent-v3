import type { AgentConfig } from "@/agent"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import type { Message } from "@/llm"
import { type CapabilityManifest, normalizeCapabilityManifest } from "@/protocol/session"
import {
  assembleConfig as canonicalAssembleConfig,
  type SessionDeps,
} from "@/runner/assemble/config"
import { runOnce } from "@/runner/orchestrate/run-once"
import { runSideChat } from "@/runner/orchestrate/side-chat"
import { buildSharedExecutionPlaneSessionDeps } from "@/runner/session-execution-plane"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import { createSingleSessionRuntimeHost } from "./builder"
import type { RuntimeHost, RuntimeSessionConfig } from "./types"

interface LegacyBootBindings {
  readonly mode: SessionBootstrapResult["mode"]
  readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
  readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
  readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
}

export interface LegacyRunnerSessionHostOptions {
  readonly boot?: LegacyBootBindings
  readonly sessionDeps: SessionDeps
  readonly assembleConfig?: (messages: Message[], deps: SessionDeps) => AgentConfig
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

export type LegacySessionConfigAssembler = RuntimeAgentTurnAssembler

export type LegacySessionDepsSource = RuntimeAgentConfigBase

export interface LegacyExecutionPlaneComposeArgs {
  readonly history: readonly Message[]
  readonly sessionDeps: SessionDeps
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: Parameters<typeof buildSharedExecutionPlaneSessionDeps>[0]["convStore"]
}

export interface LegacyMemoryAutoComposeArgs {
  readonly sessionDeps: SessionDeps
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly now?: () => number
  readonly logWarn?: (msg: string) => void
}

type LegacyBootstrapSessionDepsOverlay = Pick<
  Partial<SessionDeps>,
  | "admissibility"
  | "decisionEmitter"
  | "planExitPort"
  | "shellSnapshot"
  | "summarizerLlm"
  | "userInputPort"
>

export interface LegacyBootstrapSessionDepsArgs {
  readonly boot: SessionBootstrapResult
  readonly stream: SessionDeps["stream"]
  readonly onConfirm: SessionDeps["onConfirm"]
  readonly includeSearchPipeline?: boolean
  readonly overlay?: LegacyBootstrapSessionDepsOverlay
}

export interface ComposeLegacySessionDepsArgs extends LegacyBootstrapSessionDepsArgs {
  readonly execution?: Omit<LegacyExecutionPlaneComposeArgs, "sessionDeps">
  readonly memoryAuto?: Omit<LegacyMemoryAutoComposeArgs, "sessionDeps">
}

export const buildCapabilityManifestFromLegacySessionDeps = (
  deps: SessionDeps,
): CapabilityManifest =>
  normalizeCapabilityManifest({
    approvals: "operator",
    tools: deps.registry.all().length > 0,
    memory:
      deps.store !== undefined ||
      deps.memoryConsolidator !== undefined ||
      deps.memoryConfig !== undefined,
    artifacts: true,
    subagents:
      deps.subagentConfig !== undefined ||
      deps.delegation !== undefined ||
      deps.subagentBackground !== undefined,
    automation: deps.automationEngine !== undefined,
    shellSnapshot: deps.shellSnapshot !== undefined,
    transport: "inproc",
  })

export const assembleLegacyAgentConfig = (
  messages: Message[],
  deps: SessionDeps,
  assembleConfig: LegacySessionConfigAssembler | undefined = undefined,
): AgentConfig => (assembleConfig ?? canonicalAssembleConfig)(messages, deps)

export const extendLegacySessionDepsWithExecutionPlane = async (
  args: LegacyExecutionPlaneComposeArgs,
): Promise<SessionDeps> => ({
  ...args.sessionDeps,
  ...(await buildSharedExecutionPlaneSessionDeps({
    history: args.history,
    sessionDeps: args.sessionDeps,
    cwd: args.cwd,
    envSource: args.envSource,
    ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
  })),
})

export const extendLegacySessionDepsWithMemoryAuto = async (
  args: LegacyMemoryAutoComposeArgs,
): Promise<SessionDeps> => {
  const auto = await buildSessionMemoryAutoWires({
    env: args.env,
    llm: args.sessionDeps.llm,
    ...(args.sessionDeps.summarizerLlm !== undefined
      ? { summarizerLlm: args.sessionDeps.summarizerLlm }
      : {}),
    sessionId: args.sessionDeps.sessionId,
    signal: args.sessionDeps.signal,
    ...(args.homeDir !== undefined ? { homeDir: args.homeDir } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
    ...(args.logWarn !== undefined ? { logWarn: args.logWarn } : {}),
  })
  if (auto === undefined) return args.sessionDeps
  return {
    ...args.sessionDeps,
    ...(auto.sessionCtx !== undefined ? { sessionCtx: auto.sessionCtx } : {}),
    memoryConsolidator: auto.memoryConsolidator,
    stage1OutputsStore: auto.stage1OutputsStore,
  }
}

export const composeLegacySessionDeps = async (
  args: ComposeLegacySessionDepsArgs,
): Promise<SessionDeps> => {
  const base = buildLegacySessionDepsFromBootstrap(args)
  const withExecution =
    args.execution === undefined
      ? base
      : await extendLegacySessionDepsWithExecutionPlane({
          ...args.execution,
          sessionDeps: base,
        })
  return args.memoryAuto === undefined
    ? withExecution
    : await extendLegacySessionDepsWithMemoryAuto({
        ...args.memoryAuto,
        sessionDeps: withExecution,
      })
}

export const buildLegacySessionDepsFromBootstrap = (
  args: LegacyBootstrapSessionDepsArgs,
): SessionDeps => {
  const base: SessionDeps = {
    llm: args.boot.llm,
    registry: args.boot.tooling.registry,
    stream: args.stream,
    permission: args.boot.permission,
    system: args.boot.system,
    systemSource: args.boot.systemSource,
    cwd: args.boot.cwd,
    maxTurns: args.boot.maxTurns,
    signal: args.boot.abort.signal,
    onConfirm: args.onConfirm,
    store: args.boot.tooling.store,
    sessionId: args.boot.sessionId,
    embedder: args.boot.tooling.embedder,
    memoryConfig: args.boot.tooling.memoryConfig,
    planMode: args.boot.features.planMode,
    metrics: args.boot.features.metrics,
    run: args.boot.run,
    subagentConfig: args.boot.tooling.subagentConfig,
    skillsConfig: args.boot.tooling.skillsConfig,
    compactionBreakerConfig: args.boot.tooling.compactionBreakerConfig,
    verifyGuardConfig: args.boot.tooling.verifyGuardConfig,
    summarizerLlm: args.overlay?.summarizerLlm ?? undefined,
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
    onShellEvent: args.boot.onShellEvent,
    workMetricsSink: args.boot.workMetricsSink,
    sessionEffort: () => args.boot.effortStore.get(),
    ...(args.overlay?.decisionEmitter !== undefined
      ? { decisionEmitter: args.overlay.decisionEmitter }
      : {}),
    ...(args.overlay?.admissibility !== undefined
      ? { admissibility: args.overlay.admissibility }
      : {}),
    ...(args.overlay?.shellSnapshot !== undefined
      ? { shellSnapshot: args.overlay.shellSnapshot }
      : {}),
  }
  if (args.boot.lifecycleFollowUpQueue !== undefined) {
    base.followUpQueue = args.boot.lifecycleFollowUpQueue
  }
  if (args.boot.planStore !== undefined) {
    base.planStore = args.boot.planStore
  }
  return base
}

export const buildSessionDepsFromAgentConfigBase = (base: LegacySessionDepsSource): SessionDeps => {
  const optional: Partial<SessionDeps> = {}
  const assignIfDefined = <K extends keyof SessionDeps>(
    key: K,
    value: SessionDeps[K] | undefined,
  ): void => {
    if (value !== undefined) optional[key] = value
  }

  assignIfDefined("systemSource", base.systemSource)
  assignIfDefined("followUpQueue", base.followUpQueue)
  assignIfDefined("planStore", base.planStore)
  assignIfDefined("retrievalStack", base.retrievalStack)
  assignIfDefined("searchPipeline", base.searchPipeline)
  assignIfDefined("memoryConsolidator", base.memoryConsolidator)
  assignIfDefined("sessionCtx", base.sessionCtx)
  assignIfDefined("delegation", base.delegation)
  assignIfDefined("subagentBackground", base.subagentBackground)
  assignIfDefined("autoBackground", base.autoBackground)
  assignIfDefined("fork", base.fork)
  assignIfDefined("forkSession", base.forkSession)
  assignIfDefined("conversationCheckpoint", base.conversationCheckpoint)
  assignIfDefined("stage1OutputsStore", base.stage1OutputsStore)
  assignIfDefined("automationEngine", base.automationEngine)
  assignIfDefined("admissibility", base.admissibility)
  assignIfDefined("planExitPort", base.planExitPort)
  assignIfDefined("userInputPort", base.userInputPort)
  assignIfDefined("toolProfileState", base.toolProfileState)
  assignIfDefined("identityModeState", base.identityModeState)
  assignIfDefined("focusChain", base.focusChain)
  assignIfDefined("shellSnapshot", base.shellSnapshot)
  assignIfDefined("sessionEffort", base.sessionEffort)
  assignIfDefined("decisionEmitter", base.decisionEmitter)
  assignIfDefined("granularRegistry", base.granularRegistry)

  return {
    llm: base.llm,
    registry: base.registry,
    stream: base.stream,
    permission: base.permission,
    system: base.system,
    cwd: base.cwd,
    maxTurns: base.maxTurns,
    signal: base.signal,
    onConfirm: async (action: Parameters<SessionDeps["onConfirm"]>[0]) => {
      const result = await (base.onConfirm?.(action) ?? false)
      return typeof result === "boolean" ? result : result.decision === "allow"
    },
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
    summarizerLlm: base.compaction?.summarizerLlm,
    onShellEvent: base.onShellEvent,
    workMetricsSink: base.workMetricsSink,
    ...optional,
  }
}

export interface StartLegacySideConversationArgs extends SessionHostSideConversationArgs {
  readonly sessionDeps: SessionDeps
  readonly assembleTurnConfig?: LegacySessionConfigAssembler
  readonly defaultTools?: readonly string[]
  readonly defaultMaxTurns?: number
}

export const startLegacySideConversation = async (
  args: StartLegacySideConversationArgs,
): Promise<SessionHostSideConversationResult> => {
  const maxTurns = args.maxTurns ?? args.defaultMaxTurns
  const tools = args.tools ?? args.defaultTools
  return await runSideChat({
    deps: args.sessionDeps,
    assembleConfig: (messages, deps) =>
      assembleLegacyAgentConfig(messages, deps, args.assembleTurnConfig),
    prompt: args.question,
    mainHistory: args.messages,
    signal: args.signal,
    ...(args.inherit !== undefined ? { contextInheritance: args.inherit } : {}),
    ...(tools !== undefined ? { toolAllowlist: tools } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  })
}

export const createLegacyRunnerSessionHost = (
  options: LegacyRunnerSessionHostOptions,
): SessionHost => {
  let closed = false
  let shutdownComplete = false
  const capabilityManifest = buildCapabilityManifestFromLegacySessionDeps(options.sessionDeps)

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    await options.shutdown()
    closed = true
  }

  return {
    describe: () => ({
      sessionId: options.sessionDeps.sessionId,
      permissionMode: options.sessionDeps.permission.mode,
      capabilityManifest,
      ...(options.boot?.identityModeState !== undefined
        ? { identityMode: options.boot.identityModeState.get() }
        : {}),
      ...(options.boot?.toolProfileState !== undefined
        ? { toolProfile: options.boot.toolProfileState.get() }
        : {}),
      messages: [...options.history],
    }),
    runTurn: async ({ history, prompt, images, signal }) => {
      if (closed) throw new Error("legacy runner session host is closed")
      const turnDeps =
        signal === undefined ? options.sessionDeps : { ...options.sessionDeps, signal }
      const result = await runOnce({
        deps: turnDeps,
        assembleConfig: (messages, deps) =>
          assembleLegacyAgentConfig(messages, deps, options.assembleConfig),
        history: [...history],
        prompt,
        ...(images !== undefined && images.length > 0 ? { pendingImages: [...images] } : {}),
        state: options.state,
        idMeta: options.idMeta,
        ...(options.mcpClients !== undefined ? { mcpClients: options.mcpClients } : {}),
      })
      return { outcome: result.outcome, messages: result.messages }
    },
    setIdentityMode: async (mode) => {
      options.boot?.identityModeState?.set(mode as never)
      options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      options.boot?.toolProfileState?.set(profile as never)
    },
    startSideConversation: async (
      args: SessionHostSideConversationArgs,
    ): Promise<SessionHostSideConversationResult> =>
      await startLegacySideConversation({
        sessionDeps: options.sessionDeps,
        question: args.question,
        messages: args.messages,
        signal: args.signal,
        ...(options.assembleConfig !== undefined
          ? { assembleTurnConfig: options.assembleConfig }
          : {}),
        ...(args.inherit !== undefined ? { inherit: args.inherit } : {}),
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      }),
    close,
  }
}

export const createSingleLegacyRuntimeHost = (
  options: LegacyRunnerSessionHostOptions,
): RuntimeHost =>
  createSingleSessionRuntimeHost((_config: RuntimeSessionConfig) =>
    createLegacyRunnerSessionHost(options),
  )

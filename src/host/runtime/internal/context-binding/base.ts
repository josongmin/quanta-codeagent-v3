import type { AgentConfig } from "@/agent"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { Message } from "@/llm"
import type { CapabilityManifest } from "@/protocol/session"
import { wireInteractiveKnobs } from "@/runner/assemble"
import type {
  IdentityModeSessionState,
  ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import { buildSharedExecutionPlaneRuntimeAugments } from "@/runner/session-execution-plane"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import type { RuntimeAgentTurnAssembler, RuntimeAgentTurnDeps } from "@/sdk/runtime/base"
import { itemStreamEnabled } from "@/shared"
import { automationUpdateTool, ToolRegistry } from "@/tool"
import { deriveCapabilityManifest } from "../../capabilities"
import { installCliMentionInjector } from "../mention-wire"
import type {
  RuntimeBase,
  RuntimeBootstrapOverlay,
  RuntimeContextSnapshot,
  RuntimeExecutionComposeArgs,
  RuntimeMemoryAutoComposeArgs,
} from "./types"

export const whenDefined = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>))

export const withDefinedProps = <T extends object>(record: T): T => {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  return Object.fromEntries(entries) as T
}

export const sanitizeRuntimeBase = <T extends object>(base: T): RuntimeBase =>
  withDefinedProps(base) as unknown as RuntimeBase

export const ensureSessionId = (base: RuntimeBase): RuntimeBase =>
  base.sessionId === undefined
    ? sanitizeRuntimeBase({ ...base, sessionId: crypto.randomUUID() })
    : sanitizeRuntimeBase(base)

export const getSessionId = (base: RuntimeBase): string => base.sessionId ?? crypto.randomUUID()

export const wireRuntimePorts = (
  base: RuntimeBase,
  // Evaluated at call time so `process.env = {...}` replacements in tests
  // (which swap the binding, not the object) don't leave a stale reference.
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeBase => {
  const wired = sanitizeRuntimeBase(wireOptionalAgentPorts(base, env))
  // T01 — resolve QUANTA_ITEM_STREAM here (env in scope) and stamp it onto the
  // base so the per-turn stream port can mint a projector without re-reading env.
  return itemStreamEnabled(env) ? sanitizeRuntimeBase({ ...wired, itemStream: true }) : wired
}

export const buildCapabilityManifest = (base: RuntimeBase): CapabilityManifest =>
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

export const buildAgentConfigFromBase = (args: {
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

export const buildAgentConfigFromBaseInput = (args: {
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

export const buildBaseFromBootstrap = (args: {
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
    ...whenDefined("backgroundConsentPort", args.overlay?.backgroundConsentPort),
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
    // #20 — lift the persistent trust-scope registry onto the base so the
    // per-turn AgentConfig carries `trustScope` and the gate consults durable
    // grants. Absent ⇒ omitted (default-OFF, byte-identical).
    ...whenDefined("trustScope", args.overlay?.trustScope),
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
    // #17 (C3) — brief-mode posture. The read accessor (consumed per turn by
    // `assembleTurnContext`) and the backing store (for the `set_brief`
    // control-op write path) both project from the SAME bootstrap `briefStore`,
    // so a `/brief` slash write and a `set_brief` submission converge on one
    // cell. Seeded from `QUANTA_BRIEF`; default-OFF ⇒ getter yields false ⇒
    // byte-identical (no BRIEF_NOTICE spliced).
    sessionBrief: () => args.boot.briefStore.get(),
    briefStore: args.boot.briefStore,
  })
}

export const extendBaseWithExecutionPlane = async (
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

export const extendBaseWithMemoryAuto = async (
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
  ...whenDefined("backgroundConsentPort", base.backgroundConsentPort),
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
  ...whenDefined("radar", base.radar),
  ...whenDefined("dreamTrigger", base.dreamTrigger),
})

export const buildSnapshot = (base: RuntimeBase): RuntimeContextSnapshot => ({
  registry: base.registry,
  permission: base.permission,
  ...buildOptionalSnapshotFields(base),
})

import type { AgentConfig } from "@/agent"
import type { GranularRegistryPort } from "@/agent/checkpoint/granular-registry"
import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type {
  IdentityModeSessionState,
  SystemSource,
  ToolProfileSessionState,
} from "./session-state"

/**
 * Surface-agnostic per-turn `AgentConfig` assembly — relocated from the
 * CLI session/setup composition seam (ADR-0024 split). PURE composition: every
 * conditional default-OFF spread is preserved byte-for-byte from the prior
 * inline block. The function reads NO env/argv — the caller resolves all
 * knobs and passes them as {@link SessionDeps}.
 *
 * Surface callers should import this module directly or re-expose it from
 * their own internal barrel. There is no app-surface shim here anymore.
 */

/** Inputs the per-turn `AgentConfig` is assembled from. Grouping the optional
 *  default-OFF knobs keeps `assembleConfig` a single cohesive site and lifts
 *  the conditional-spread chain out of the surface entry. */
export interface SessionDeps {
  llm: LLMPort
  registry: ToolRegistry
  stream: StreamPort
  permission: PermissionContext
  /** Already-built system prompt (`buildSystemPrompt(cwd, { persona })`).
   *  Resolved by the caller so this module stays env-free. */
  system: string
  /** Optional live system-prompt source. When wired, `assembleConfig`
   *  re-reads the prompt each turn so a surface-owned identity swap applies
   *  without restarting the session. */
  systemSource?: SystemSource
  cwd: string
  maxTurns: number
  signal: AbortSignal
  onConfirm: (action: ToolAction) => Promise<boolean>
  store: PersistentStorePort | undefined
  sessionId: string
  embedder: EmbedderPort | undefined
  memoryConfig: AgentConfig["memory"] | undefined
  planMode: boolean
  metrics: Metrics | undefined
  run: RunContext | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
  /** Surface-owned alternate LLM registry for per-turn model selection
   *  (`session_config` / skill overrides / fast-apply fallback resolver).
   *  Absent ⇒ the primary `llm` is the only selectable port. */
  modelCandidates?: AgentConfig["modelCandidates"]
  summarizerLlm: LLMPort | undefined
  /** Session-scoped role→model override carrier shared with any consumer that
   *  needs role-based model selection (for example fast-apply fallback). */
  roleModelResolver?: AgentConfig["roleModelResolver"]
  /** ADR-0081 shell-output-delta observer composed by the surface. Absent ⇒
   *  runShell stays on its legacy buffered path (byte-identical). */
  onShellEvent: AgentConfig["onShellEvent"] | undefined
  /** ADR-0064 L4 per-turn work-metrics sink. Absent ⇒ the loop allocates no
   *  collector and emits nothing (byte-identical default-OFF). */
  workMetricsSink: AgentConfig["workMetricsSink"] | undefined
  /** ADR-0037 follow-up queue (surface-owned). When set, the loop polls
   *  `popReady` at the top of each turn (gated on `pausedReason`). The CLI
   *  also keeps the reference so lifecycle pills can render queue depth.
   *  Absent ⇒ no poll, no allocation, byte-identical legacy. */
  followUpQueue?: AgentConfig["followUpQueue"]
  /** S3 slashctx-port wire: surface-owned `PlanStore` reference. Threaded into
   *  `AgentConfig.planStore` so the agent's plan tools mutate the SAME store the
   *  surface reads from `/plan`. Absent ⇒ field omitted from `AgentConfig`
   *  (byte-identical default-OFF — the loop's plan-hydrate/persist helpers
   *  no-op when `planStore` is undefined). */
  planStore?: AgentConfig["planStore"]
  /** ADR-0159 retrieval-stack wire — built by `buildRetrievalStackCore`.
   *  Absent ⇒ omitted from AgentConfig entirely (byte-identical default-OFF:
   *  consumers' bridge functions return identity behavior when the slot is
   *  undefined). The agent loop itself NEVER reads this slot — only the
   *  bridge consumer (`rankWithRetrievalStack`) does. */
  retrievalStack?: AgentConfig["retrievalStack"]
  /** Helper-only search pipeline slot paired with any surface-registered
   *  `search_codebase` facade. Absent ⇒ omitted from AgentConfig entirely. */
  searchPipeline?: AgentConfig["searchPipeline"]
  /** ADR-0068 session-end consolidator hook. Absent ⇒ no session-end
   *  Phase1+write path (byte-identical legacy). */
  memoryConsolidator?: AgentConfig["memoryConsolidator"]
  /** Static session-context block injected into the cached system sections.
   *  Used for cross-session memory summaries and other host-owned context. */
  sessionCtx?: AgentConfig["sessionCtx"]
  /** Distilled `memory_summary.md` body loaded once per session start. */
  memorySummaryMd?: AgentConfig["memorySummaryMd"]
  /** ADR-0218 / ADR-0283 typed delegation surface. Helper-only today; hosts
   *  may publish it to slash/tools. Absent ⇒ omitted entirely. */
  delegation?: AgentConfig["delegation"]
  /** ADR-0140 detached subagent scheduler. When present, Tier-1 registers
   *  `subagent_fork|poll|await`. Absent ⇒ no background tool plane. */
  subagentBackground?: AgentConfig["subagentBackground"]
  /** ADR-0223 stuck-tool observer/proposer surface. Absent ⇒ dispatch's
   *  `tickToolStart` / `tickToolEnd` optional-chain is a no-op. */
  autoBackground?: AgentConfig["autoBackground"]
  /** ADR-0201 base fork-session tool slot. Absent ⇒ `fork_session` tool is
   *  not registered. */
  fork?: AgentConfig["fork"]
  /** ADR-0226 rich fork-session slash/port slot. Absent ⇒ rich branch-aware
   *  fork surface remains unavailable. */
  forkSession?: AgentConfig["forkSession"]
  /** ADR-0124 helper-only conversation checkpoint store. Lets surfaces share
   *  one snapshot store across fork/rewind/recovery consumers. */
  conversationCheckpoint?: AgentConfig["conversationCheckpoint"]
  /** Session-owned Responses continuation store. Execution-plane wrappers
   *  consume this to keep `previous_response_id` state off shared adapter
   *  instances. */
  responsesContinuation?: AgentConfig["responsesContinuation"]
  /** ADR-0207 helper-only usage/selection cache for cross-session memory
   *  injection and promotion bookkeeping. */
  stage1OutputsStore?: AgentConfig["stage1OutputsStore"]
  /** ADR-0215 / ADR-0239 automation engine slot. Absent ⇒ no ticker and no
   *  `automation_update` default tool registration. */
  automationEngine?: AgentConfig["automationEngine"]
  /** Wave-A admissibility bundle (reviewer/rules/store bridge). Absent ⇒
   *  dispatch passes no extra gate options (byte-identical legacy). */
  admissibility?: AgentConfig["admissibility"]
  /** Host-owned plan-exit surface. Present ⇒ `request_plan_exit` is
   *  registered and dispatch wires `ToolContext.requestPlanExit`. */
  planExitPort?: AgentConfig["planExitPort"]
  /** Host-owned operator-input surface. Present ⇒ `request_user_input` is
   *  registered and dispatch wires `ToolContext.requestUserInput`. */
  userInputPort?: AgentConfig["userInputPort"]
  /** ADR-0296 PROMPT-mode consent surface. Present ⇒ dispatch wires
   *  `ToolContext.requestBackgroundConsent`, so `prompt` mode asks before
   *  detaching. Absent ⇒ `prompt` degrades to `background` (byte-identical). */
  backgroundConsentPort?: AgentConfig["backgroundConsentPort"]
  /** Authoritative live tool-profile slot. The session surface and the gate
   *  share ONE state object; `assembleConfig` projects it into
   *  `AgentConfig.toolProfile.activeName`. */
  toolProfileState?: ToolProfileSessionState
  /** Authoritative live identity-mode slot. The session surface and the
   *  loop share ONE state object; `assembleConfig` projects it into
   *  `AgentConfig.identityModeVariant.activeMode`. */
  identityModeState?: IdentityModeSessionState
  /** Prompt-surface profile projected onto the assembled config so non-
   *  bootstrap callers keep the same prompt-section routing as bootstrap. */
  promptSurfaceProfile?: AgentConfig["promptSurfaceProfile"]
  /** Authoritative focus-chain tracker slot shared by the slash surface and
   *  the loop. Absent ⇒ field omitted from `AgentConfig`. */
  focusChain?: AgentConfig["focusChain"]
  /** ADR-0237 — per-turn shell-snapshot config block. The CLI composition
   *  root (`apps/cli/internal.ts`) builds this when `QUANTA_SHELL_SNAPSHOT=1`
   *  or `--shell-snapshot` is set, injecting a Bun-spawner backed port plus
   *  the 5-knob block (`shell` / `captureAtTurnStart` / `cleanupOlderThanMs`
   *  / `maxSizeBytes` / `shellEnv`). Absent ⇒ field omitted from
   *  AgentConfig entirely (byte-identical default-OFF: every `runShell`
   *  spawn is the legacy `["bash","-lc",cmd]` argv). */
  shellSnapshot?: AgentConfig["shellSnapshot"]
  /** Session-level reasoning-effort accessor (`/effort` slash + `QUANTA_EFFORT`
   *  env, Codex `/model`-style UX but effort-only). Surface owns the mutable
   *  store; this is a read-only accessor the loop calls once per turn via
   *  `AgentConfig.sessionEffort`, so a runtime change applies on the next
   *  turn without re-assembling AgentConfig. Absent ⇒ omitted entirely
   *  (byte-identical default-OFF: no `thinking` field on LLMInput). */
  sessionEffort?: AgentConfig["sessionEffort"]
  /** Session-scoped advisory effort classifier. Absent ⇒ the loop's
   *  escalate-only floor remains a no-op. */
  effortClassifier?: AgentConfig["effortClassifier"]
  /** Apply-patch fast fallback port. Absent ⇒ `apply_patch` remains on the
   *  single-attempt legacy path. */
  fastApplyFallback?: AgentConfig["fastApplyFallback"]
  /** ADR-0269 Phase 3 closure — gate-decision emitter port. When present,
   *  `runAdmissibilityGate` (permission/rule/hook) + dispatch's cap
   *  reminder + loop's budget-exhaustion + storage's fs-jail deny each
   *  emit a `decision` AgentEvent through this port. The CLI composition
   *  root builds it via `decisionEmitterFromStream(stream)` so the same
   *  tee that feeds debug-tracer / decision-counter-sink / OTLP exporter
   *  receives the emit. Absent ⇒ all 6 gate sites silently no-op
   *  (byte-identical pre-ADR-0269 path; gates' return values + side
   *  effects unchanged). */
  decisionEmitter?: AgentConfig["decisionEmitter"]
  /** ADR-0300/0304 — per-session granular checkpoint registry. The
   *  surface composer instantiates ONE registry per session and mirrors
   *  it here so `assembleConfig` carries it onto `AgentConfig.
   *  granularRegistry`. Helper-only — the agent loop NEVER reads it;
   *  caller-side surface wires (per-tool snapshot recorder, future
   *  /rewind-tool revision) consume it directly. Absent ⇒ omitted from
   *  AgentConfig entirely (byte-identical default-OFF). */
  granularRegistry?: GranularRegistryPort
  /** `session_config` tool seam — read + write over the agent's own SDK
   *  posture (effort tier, permission mode, identity mode, tool profile,
   *  model, provider). Built by the composition root from the pre-existing
   *  `effortStore` + `permissionModeState` + `identityModeState` +
   *  `toolProfileState`. Absent ⇒ omitted from AgentConfig (byte-identical
   *  default-OFF: the tool itself is registered unconditionally and yields a
   *  typed `not_wired` failure when called). */
  sessionConfigPort?: AgentConfig["sessionConfigPort"]
}

/** Compaction config dependency. Present when memory/store is on (preserving
 *  the prior `compaction: {}` default) OR a dedicated summarizer model is set;
 *  carries `summarizerLlm` when configured. Absent when neither ⇒ omitted
 *  entirely (byte-identical to the pre-knob default path). */
export const compactionDep = (d: {
  store: PersistentStorePort | undefined
  summarizerLlm: LLMPort | undefined
}): AgentConfig["compaction"] | undefined => {
  if (!d.store && !d.summarizerLlm) return undefined
  return d.summarizerLlm ? { summarizerLlm: d.summarizerLlm } : {}
}

/**
 * Compose a per-turn `AgentConfig` from typed dependencies + history.
 *
 * **Why "assemble" vs "build"** — the surface-agnostic builder family
 * (`buildLLMCore`, `buildStoreCore`, `buildMemoryConfigCore`, etc.) each
 * INSTANTIATE a single collaborator object. `assembleConfig` is different:
 * it *composes* already-built pieces (passed in via {@link SessionDeps}) plus
 * the message history into the immutable shape `runAgent` consumes. No new
 * collaborator is constructed here — it's pure type-safe composition, and
 * every conditional spread is preserved byte-for-byte from the prior inline
 * block on the surface entry.
 *
 * Inputs are plain typed objects (no `process.env` / `argv` reads). Each
 * surface (CLI / Web / Tauri) maps its own input source (ENV / HTTP body /
 * IPC payload) → {@link SessionDeps} first, then calls this.
 *
 * @see buildLLMCore, buildStoreCore, buildMemoryConfigCore for the per-
 *      collaborator factories that produce the inputs to this composer.
 */
/** Core memory + telemetry + collaboration spreads (Phase 1 of the
 *  optional-key cohort — split so each helper fits under the biome
 *  cognitive-complexity cap). Pure. Byte-identical to the inline chain. */
const buildMemoryAndModeSpreads = (
  d: SessionDeps,
  compaction: AgentConfig["compaction"] | undefined,
): Partial<AgentConfig> => ({
  // Store/sessionId gated on memory; compaction is now decoupled so a
  // dedicated summarizer model works without a store. Store-only ⇒
  // `compaction: {}` exactly as before (byte-identical).
  ...(d.store ? { store: d.store, sessionId: d.sessionId } : {}),
  ...(compaction ? { compaction } : {}),
  ...(d.embedder ? { embedder: d.embedder } : {}),
  ...(d.memoryConfig ? { memory: d.memoryConfig } : {}),
  ...(d.planMode ? { planMode: true } : {}),
  ...(d.metrics ? { metrics: d.metrics } : {}),
  ...(d.run ? { run: d.run } : {}),
  ...(d.subagentConfig ? { subagent: d.subagentConfig } : {}),
})

const buildPromptVariantSpreads = (d: SessionDeps): Partial<AgentConfig> => ({
  ...(d.focusChain !== undefined ? { focusChain: d.focusChain } : {}),
  ...(d.promptSurfaceProfile !== undefined
    ? { promptSurfaceProfile: d.promptSurfaceProfile }
    : {}),
  ...(() => {
    const state = d.toolProfileState
    return state !== undefined
      ? {
          toolProfile: {
            resolver: state.resolver,
            ...(state.defaultName !== undefined ? { defaultName: state.defaultName } : {}),
            activeName: () => state.get() ?? state.defaultName ?? "write",
          },
        }
      : {}
  })(),
  ...(() => {
    const state = d.identityModeState
    return state !== undefined
      ? {
          identityModeVariant: {
            registry: state.registry,
            ...(state.perTurnReminderEnabled !== undefined
              ? { perTurnReminderEnabled: state.perTurnReminderEnabled }
              : {}),
            activeMode: () => state.getPromptMode() ?? state.defaultMode ?? "default",
          },
        }
      : {}
  })(),
})

const buildObservabilityAndPortsSpreads = (d: SessionDeps): Partial<AgentConfig> => ({
  ...(d.onShellEvent !== undefined ? { onShellEvent: d.onShellEvent } : {}),
  ...(d.workMetricsSink !== undefined ? { workMetricsSink: d.workMetricsSink } : {}),
  ...(d.decisionEmitter !== undefined ? { decisionEmitter: d.decisionEmitter } : {}),
  ...(d.planExitPort !== undefined ? { planExitPort: d.planExitPort } : {}),
  ...(d.userInputPort !== undefined ? { userInputPort: d.userInputPort } : {}),
  ...(d.backgroundConsentPort !== undefined
    ? { backgroundConsentPort: d.backgroundConsentPort }
    : {}),
  ...(d.followUpQueue !== undefined ? { followUpQueue: d.followUpQueue } : {}),
  ...(d.planStore !== undefined ? { planStore: d.planStore } : {}),
})

const buildOptionalAgentPortSpreads = (d: SessionDeps): Partial<AgentConfig> => ({
  ...(d.modelCandidates !== undefined ? { modelCandidates: d.modelCandidates } : {}),
  ...(d.roleModelResolver !== undefined ? { roleModelResolver: d.roleModelResolver } : {}),
  ...(d.effortClassifier !== undefined ? { effortClassifier: d.effortClassifier } : {}),
  ...(d.fastApplyFallback !== undefined ? { fastApplyFallback: d.fastApplyFallback } : {}),
})

/** Capability + observability spreads (Phase 2 of the optional-key
 *  cohort). Pure. Byte-identical to the inline chain. */
const buildCapabilityAndObservabilitySpreads = (d: SessionDeps): Partial<AgentConfig> => ({
  ...(d.skillsConfig ? { skills: d.skillsConfig } : {}),
  ...(d.compactionBreakerConfig ? { compactionBreaker: d.compactionBreakerConfig } : {}),
  ...(d.verifyGuardConfig ? { verifyGuard: d.verifyGuardConfig } : {}),
  ...(d.admissibility !== undefined ? { admissibility: d.admissibility } : {}),
  ...(d.retrievalStack !== undefined ? { retrievalStack: d.retrievalStack } : {}),
  ...(d.searchPipeline !== undefined ? { searchPipeline: d.searchPipeline } : {}),
  ...(d.shellSnapshot !== undefined ? { shellSnapshot: d.shellSnapshot } : {}),
  ...(d.sessionEffort !== undefined ? { sessionEffort: d.sessionEffort } : {}),
  ...buildOptionalAgentPortSpreads(d),
  ...buildObservabilityAndPortsSpreads(d),
  ...buildPromptVariantSpreads(d),
})

/** Execution-plane helper spreads. Kept separate so new product-plane slots
 *  do not keep inflating the already-dense capability/observability cohort. */
const buildExecutionPlaneSpreads = (d: SessionDeps): Partial<AgentConfig> => ({
  ...(d.memoryConsolidator !== undefined ? { memoryConsolidator: d.memoryConsolidator } : {}),
  ...(d.sessionCtx !== undefined ? { sessionCtx: d.sessionCtx } : {}),
  ...(d.memorySummaryMd !== undefined ? { memorySummaryMd: d.memorySummaryMd } : {}),
  ...(d.delegation !== undefined ? { delegation: d.delegation } : {}),
  ...(d.subagentBackground !== undefined ? { subagentBackground: d.subagentBackground } : {}),
  ...(d.autoBackground !== undefined ? { autoBackground: d.autoBackground } : {}),
  ...(d.fork !== undefined ? { fork: d.fork } : {}),
  ...(d.forkSession !== undefined ? { forkSession: d.forkSession } : {}),
  ...(d.conversationCheckpoint !== undefined
    ? { conversationCheckpoint: d.conversationCheckpoint }
    : {}),
  ...(d.responsesContinuation !== undefined
    ? { responsesContinuation: d.responsesContinuation }
    : {}),
  ...(d.granularRegistry !== undefined ? { granularRegistry: d.granularRegistry } : {}),
  ...(d.stage1OutputsStore !== undefined ? { stage1OutputsStore: d.stage1OutputsStore } : {}),
  ...(d.automationEngine !== undefined ? { automationEngine: d.automationEngine } : {}),
  ...(d.sessionConfigPort !== undefined ? { sessionConfigPort: d.sessionConfigPort } : {}),
})

export const assembleConfig = (messages: Message[], d: SessionDeps): AgentConfig => {
  const compaction = compactionDep(d)
  return {
    llm: d.llm,
    registry: d.registry,
    stream: d.stream,
    permission: d.permission,
    messages,
    system: d.systemSource?.get() ?? d.system,
    cwd: d.cwd,
    maxTurns: d.maxTurns,
    signal: d.signal,
    onConfirm: d.onConfirm,
    ...buildMemoryAndModeSpreads(d, compaction),
    ...buildCapabilityAndObservabilitySpreads(d),
    ...buildExecutionPlaneSpreads(d),
  }
}

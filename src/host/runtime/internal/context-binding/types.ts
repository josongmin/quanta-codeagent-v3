import type { AgentConfig } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { ArtifactRegistry } from "@/artifact"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { Message, ResponsesContinuationStore } from "@/llm"
import type { CrossSessionDreamTrigger } from "@/memory"
import type {
  IdentityModeSessionState,
  PermissionModeSessionState,
  SystemSource,
  ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import type { ArtifactPreviewResolver } from "../../artifact-preview-resolver"
import type { RuntimeHost } from "../../types"

export type RuntimeBase = RuntimeAgentConfigBase & {
  approvalProtocol?: RuntimeApprovalProtocolConfig
  /** T01 — `QUANTA_ITEM_STREAM` resolved ONCE at the composition boundary
   *  ({@link wireRuntimePorts}, where env is available). When true, each turn's
   *  {@link createTurnStreamPort} runs a fresh {@link ItemStreamProjector} so the
   *  session wire carries `item.*` events. Absent ⇒ no projector, byte-identical. */
  itemStream?: boolean
  /** A2 — the SINGLE per-session Canvas artifact registry (the SAME instance the
   *  `artifact_*` tools + generation-tool `artifactSink` write into), lifted onto
   *  the base by the composition root ONLY when `QUANTA_ARTIFACT_STORE` is on.
   *  Two consumers: (1) `buildCapabilityManifest` sets the `artifacts` capability
   *  bit true iff present; (2) the turn runner drains newly-registered artifacts
   *  from it into `result.artifacts` (the MISSING PRODUCER for `artifact.ready`).
   *  Absent ⇒ capability false, no producer (byte-identical default-OFF). */
  artifactRegistry?: ArtifactRegistry
  /** A2 — the host-side READ-ONLY `quanta-artifact://` preview resolver over the
   *  SAME shared registry (see {@link artifactRegistry}). Minted at the comp root
   *  behind `QUANTA_ARTIFACT_STORE`; a future IPC handler reads it here to serve
   *  jailed preview bytes. Absent ⇒ no preview channel (byte-identical). */
  artifactPreviewResolver?: ArtifactPreviewResolver
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
  /** S1 (jul-04) `/browser-net` — surface-owned net-capture sink threaded DOWN
   *  from the CLI compose seam. Carried on the base so the per-turn assembler
   *  (`maybeWireBrowser`) reads it off `req.base` and attaches it to
   *  `config.browser.netHolder`. Absent ⇒ no mirror (byte-identical). */
  browserNet?: SnapshotBrowserNetSink
}

export interface RuntimeConfirmSlot {
  current: NonNullable<AgentConfig["onConfirm"]>
}

export interface RuntimeApprovalProtocolConfig {
  readonly confirmSlot: RuntimeConfirmSlot
  /** jun-10 HITL restructure — the surface has a LIVE OPERATOR (interactive
   *  CLI): a mid-turn "ask" should delegate INLINE to the surface confirm that
   *  was in the slot at `runWithProtocol` entry, instead of minting a pending
   *  approval and aborting the whole turn (the deferred protocol re-runs the
   *  turn from scratch — re-paying the full prompt per approval). Absent/false
   *  ⇒ byte-identical deferred behavior (web/SDK/headless round-trip). */
  readonly interactive?: boolean
}

export interface BootBindings {
  readonly mode: SessionBootstrapResult["mode"]
  readonly refreshSystemPrompt: SessionBootstrapResult["refreshSystemPrompt"]
  readonly toolProfileState?: SessionBootstrapResult["toolProfileState"] | undefined
  readonly identityModeState?: SessionBootstrapResult["identityModeState"] | undefined
}

export interface RuntimeContextSnapshot {
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
  readonly backgroundConsentPort?: AgentConfig["backgroundConsentPort"]
  readonly conversationCheckpoint?: AgentConfig["conversationCheckpoint"]
  readonly responsesContinuation?: AgentConfig["responsesContinuation"]
  readonly fork?: AgentConfig["fork"]
  readonly forkSession?: AgentConfig["forkSession"]
  readonly delegation?: AgentConfig["delegation"]
  readonly subagentBackground?: AgentConfig["subagentBackground"]
  readonly autoBackground?: AgentConfig["autoBackground"]
  readonly sessionCtx?: AgentConfig["sessionCtx"]
  readonly memorySummaryMd?: AgentConfig["memorySummaryMd"]
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
  /** ADR-0231 (wire phase) — radar proposal-queue producer block, folded onto
   *  the built `AgentConfig.radar` so the loop samples at each COMPLETED turn. */
  readonly radar?: AgentConfig["radar"]
  /** H16 — the live cross-session dream trigger (auto path's SAME instance),
   *  surfaced so the REPL can wire `/dream`. Present only when
   *  `QUANTA_AUTO_DREAM=1` produced a trigger. */
  readonly dreamTrigger?: CrossSessionDreamTrigger
  /** S1 (jul-04) `/browser-net` — the surface-owned network-capture sink, threaded
   *  DOWN from the CLI (mirrors `radar`). It flows onto the per-turn base so
   *  `maybeWireBrowser` attaches it to `config.browser.netHolder`. Structurally
   *  typed (`{ set }`) to avoid a cycle back into the tool/SDK slices. Absent ⇒
   *  no mirror (byte-identical). */
  readonly browserNet?: SnapshotBrowserNetSink
}

/** S1 (jul-04) — structural mirror of `@/tool/browser`'s `BrowserNetSink`, kept
 *  local so the context-binding layer has no cycle into the tool slice. */
export interface SnapshotBrowserNetSink {
  set(snapshot: { readonly rows: readonly unknown[]; readonly at: number }): void
}

export type RuntimeContextPatch = Partial<
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
    | "backgroundConsentPort"
    | "conversationCheckpoint"
    | "responsesContinuation"
    | "fork"
    | "forkSession"
    | "delegation"
    | "subagentBackground"
    | "autoBackground"
    | "sessionCtx"
    | "memorySummaryMd"
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
    | "radar"
    | "browserNet"
  >
>

export interface CreateRuntimeContextHostArgs {
  readonly boot?: BootBindings
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
}

export interface RuntimeContextBindingState {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface RuntimeContextBinding {
  readonly snapshot: RuntimeContextSnapshot
  patch(patch: RuntimeContextPatch): RuntimeContextBinding
  createRuntimeHost(args: CreateRuntimeContextHostArgs): RuntimeHost
  materializeReviewerAgent(
    boot: SessionBootstrapResult,
    turnAssembler?: RuntimeAgentTurnAssembler,
  ): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]>
}

export interface RuntimeExecutionComposeArgs {
  readonly history: readonly Message[]
  readonly base: RuntimeBase
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

export interface RuntimeMemoryAutoComposeArgs {
  readonly base: RuntimeBase
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly now?: () => number
  readonly logWarn?: (msg: string) => void
}

export type RuntimeBootstrapOverlay = {
  readonly promptSurfaceProfile?: AgentConfig["promptSurfaceProfile"]
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
  readonly backgroundConsentPort?: AgentConfig["backgroundConsentPort"]
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
  /** #20 (durable prefix grants) — persistent trust-scope registry + projectKey.
   *  When set (the comp-root wires it behind `QUANTA_TRUST_SCOPE`), the base
   *  carries `trustScope` so the admissibility gate's ask-branch consults
   *  `hasGrant` (a durable "always allow `git …`" grant ask-skips matching
   *  commands across sessions). Absent ⇒ slot omitted (default-OFF,
   *  byte-identical: the gate's `trustScopeGrants` returns false). */
  readonly trustScope?: AgentConfig["trustScope"]
}

export interface RuntimeBootstrapHelpers {
  materializeReviewerAgent(
    boot: SessionBootstrapResult,
    turnAssembler?: RuntimeAgentTurnAssembler,
  ): ReturnType<SessionBootstrapResult["materializeReviewerAgent"]>
}

export interface CreateRuntimeContextBindingFromBootstrapArgs {
  readonly boot: SessionBootstrapResult
  readonly stream: AgentConfig["stream"]
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  readonly includeSearchPipeline?: boolean
  readonly overlay?: RuntimeBootstrapOverlay
  readonly execution?: Omit<RuntimeExecutionComposeArgs, "base" | "turnAssembler">
  readonly memoryAuto?: Omit<RuntimeMemoryAutoComposeArgs, "base">
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}

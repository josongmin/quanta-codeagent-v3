import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { FocusChainPort } from "@/agent/focus-chain"
import type { IdentityMode } from "@/agent/identity"
import type { GranularRegistry, ThreeWayRestorePort } from "@/agent/per-tool-checkpoint"
import type { PlanStore } from "@/agent/plan/state"
import type { StickyModelStore } from "@/agent/sticky-model"
import type { SystemPromptVariantRegistry } from "@/agent/system-prompt"
import type { ToolProfileName, ToolProfileResolver } from "@/agent/tool-profile"
import type { LLMPort, Message } from "@/llm"
import type {
  IdentityModeSessionState,
  ToolProfileSessionState,
} from "@/runner/assemble/session-state"
import { getBashBgRegistry } from "@/runtime/bash-bg-registry"
import type { RuntimeSideConversationArgs, RuntimeSideConversationResult } from "@/sdk/runtime"
import type { SessionEnvelopeRecord } from "@/session"
import { redactValue } from "@/shared"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { ComposerEditPort } from "../edit-message-cmd"
import type { PlanEditPort } from "../edit-plan-cmd"
import type { ForkSessionSlashState } from "../fork-checkpoint-cmd"
import type { HistorySessionState } from "../history-cmd"
import type { IdleMonitor } from "../idle-monitor"
import { runImageCmd } from "../image-cmd"
import type { ImageQueue } from "../image-queue"
import type { InspectSlashState } from "../inspect-cmd"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { ProcPanelRow } from "../proc-panel"
import type { RewindSlashState } from "../rewind-cmd"
import type { PerToolCheckpointSlashState } from "../rewind-tool-cmd"
import type { SideCmdSlashState } from "../side-cmd"
import { isProcPanelEnabled } from "../slash/registry-surface"
import { isSlashCommand, runSlashCommand, type SkillRow } from "../slash-commands"
import type { TextInbox } from "../text-inbox"
import type { WhySlashState } from "../why-cmd"
import { buildComposerEditAdapter, type ComposerHandle } from "./ctx-adapters/composer-edit-adapter"
import { buildFocusChainAdapter } from "./ctx-adapters/focus-chain-adapter"
import { buildForkSessionAdapter } from "./ctx-adapters/fork-session-adapter"
import {
  buildIdentityModeAdapter,
  ONBOARDING_IDENTITY_KEY,
} from "./ctx-adapters/identity-mode-adapter"
import { buildPerToolCheckpointAdapter } from "./ctx-adapters/per-tool-checkpoint-adapter"
import { buildPlanEditAdapter } from "./ctx-adapters/plan-edit-adapter"
import { buildStickyModelAdapter } from "./ctx-adapters/sticky-model-adapter"
import { buildToolProfileAdapter } from "./ctx-adapters/tool-profile-adapter"
import type { DebugTracerHandle } from "./session-setup"

/** Adapter the REPL composer threads through to `/replay`. The slash command
 *  declares the same shape locally via `declare module` (replay-cmd.ts); this
 *  copy is the structural mirror — keeping it inline here avoids a cross-file
 *  type import where one would re-introduce a slice cycle. */
export interface ReplaySlashState {
  readonly resolveSession: (id: string) => Promise<string | undefined>
  readonly iterate: (path: string) => AsyncIterable<SessionEnvelopeRecord>
}

/** Shared REPL-side slash-context state. Threaded through
 *  {@link dispatchReplSlash} → `runSlashCommand`. Each field is independently
 *  optional so surfaces can omit unsupported adapters and keep the existing
 *  "not wired" behavior. */
export type ReplSlashCtx = Partial<{
  /** Optional cwd override for legacy/test slash dispatchers. Absent ⇒ the
   *  shell-entry ambient cwd (`process.cwd()`) is preserved. */
  cwd: string
  /** ADR — `/ps` owned-background-shell panel. Declared HERE, not only on the
   *  slash contract: the builder spread it (`procShellsSlot`) while this type
   *  did not name it, so `projectSlashCtx` dropped it and `/ps` printed "not
   *  wired" in every session — the same defect as `/attention`, and invisible
   *  to the exhaustive `Record<keyof ReplSlashCtx, …>` precisely because the
   *  key was absent from `keyof`. Absent ⇒ omitted ⇒ "not wired". */
  procShells: () => readonly ProcPanelRow[]
  skills: () => Promise<SkillRow[]>
  /** RFC-06 F4 — `/reload-skills` authority-backed sync + revision hook. */
  reloadSkills: () => Promise<{ rows: SkillRow[]; revision?: number }>
  idle: IdleMonitor
  /** F1a — the session's repo-rules snapshot for `/rules` (see SlashContext). */
  repoRules: import("@/agent").RepoRules
  imageQueue: ImageQueue
  rewindSession: RewindSlashState
  mcp: McpSurfaceInfo
  cost: () => string
  planSnapshot: () => import("@/agent/plan/types").Plan | null
  history: HistorySessionState
  branchSearch: () => import("../branch-search-progress").BranchProgressState
  /** `/side` SessionState FACTORY — built fresh on each invocation so the
   *  starter sees the live transcript rather than a stale snapshot captured
   *  when the REPL started. The state's `start` field is the surface-built
   *  runtime-side starter; engine-internal types stay encapsulated inside the
   *  adapter (ADR-0304 / Runtime SDK cutover). */
  side: () => SideCmdSlashState
  /** ADR-0239 — debug-tracer runtime toggle. Present iff the boot gate
   *  (`QUANTA_DEBUG=1` + TTY) allocated the mutable proxy port; absent ⇒
   *  `/debug` slash prints "not wired" + the QUANTA_DEBUG hint. */
  debug: DebugTracerHandle
  /** ADR-0271 — `/why` meta-LLM reasoning query slot. Present iff the
   *  REPL surface has both an active sessionId and an active LLMPort
   *  (full session setup). Absent ⇒ `/why` prints "not wired in this
   *  surface" + exit 0. */
  why: WhySlashState
  /** Track I (ADR-0239 follow-up) — `/inspect <toolCallId>` surface
   *  wire. Present iff the REPL host has an active session id to point
   *  `findByToolCallId` at; absent ⇒ `/inspect` reports "no active
   *  session" and exits 1. */
  inspect: InspectSlashState
  /** Track R — `/replay <session-id>` surface wire. Present iff the
   *  composer can resolve a session id → JSONL path + iterate decoded
   *  envelopes; absent ⇒ `/replay` prints "not wired in this surface" +
   *  exit 0 (parity with the other surface-only commands). */
  replay: ReplaySlashState
  /** Session-level reasoning-effort wire. Closes over the surface-owned
   *  `EffortStore` AND the status pill so `/effort <level>` mutates both
   *  on the same tick. */
  effort: {
    readonly get: () => import("@/agent").EffortLevel
    readonly set: (level: import("@/agent").EffortLevel) => void
    readonly levels: readonly import("@/agent").EffortLevel[]
    readonly budgetTokens: (level: import("@/agent").EffortLevel) => number | undefined
  }
  /** #17 (C3) — `/brief` session-posture wire. Closes over the surface-owned
   *  `BriefStore`; ORTHOGONAL to {@link effort}. Absent ⇒ `/brief` prints "not
   *  wired in this surface". */
  brief: {
    readonly get: () => boolean
    readonly set: (on: boolean) => void
  }
  /** ADR-0291 — `/edit-plan` plan-edit wire. Wraps the surface-owned
   *  `PlanStore`; absent ⇒ slash prints "not wired in this surface". */
  planEdit: PlanEditPort
  /** ADR-0291 — `/edit-message` composer-edit wire. Surface-owned mutable
   *  pending-text holder; absent ⇒ slash prints "not wired in this surface". */
  composerEdit: ComposerEditPort
  /** ADR-0291 — `/fork-checkpoint` 4-verb fork wire. Composes
   *  `ConversationCheckpointStore` + `defaultForker` (ADR-0226). */
  forkSession: ForkSessionSlashState
  /** ADR-0291 — `/rewind-tool` 3-way restore wire. Skeleton today: the
   *  `restoreFiles/Task/Both` arms may return typed not-yet-wired
   *  outcomes when the host omits the real ports. */
  perToolCheckpoint: PerToolCheckpointSlashState
  /** RFC-def `/undo` — the durable hunk-mutation journal store wire (built
   *  ONLY under `QUANTA_HUNK_UNDO=1`). Absent ⇒ `/undo` prints "not wired". */
  hunkUndo: import("../undo-cmd").HunkUndoSlashState
  /** ADR-0291 — `/profile` tool-profile wire. Adapter over
   *  `AgentConfig.toolProfile.resolver` + `defaultName`. */
  profile: {
    readonly get: () => string
    readonly set: (
      name: string,
    ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
    readonly list: () => readonly string[]
  }
  /** ADR-0291 — `/identity` identity-mode wire. Adapter over
   *  `AgentConfig.identityModeVariant.registry`. */
  identity: {
    readonly get: () => string
    readonly set: (
      mode: string,
    ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
    readonly list: () => readonly string[]
  }
  /** ADR-0462 — `/sticky-model` SET wire. Adapter over a fs-backed
   *  `StickyModelStore`; the consume side (agent loop) reads the same file. */
  stickyModel: ReturnType<typeof buildStickyModelAdapter>
  /** ADR-0291 — `/focus-chain` Cline-style todo tracker wire. Adapter
   *  over `AgentConfig.focusChain.tracker` (ADR-0219). */
  focusChain: {
    readonly snapshot: () => {
      readonly todos: ReadonlyArray<{ readonly text: string; readonly state: string }>
      readonly currentTurn: number
      readonly driftWarning: string | null
    }
    readonly reset: () => void
    readonly skip: () => void
  }
  /** ADR-0291 — `/web` text-inbox singleton. Drained by next-turn
   *  `PromptSource.next()`; absent ⇒ `/web` prints inline. */
  textInbox: TextInbox
  /** Track D — segmented context-window usage seam. Returns the breakdown for
   *  the LATEST assembled prompt (per-category token segments) mapped to the
   *  renderer's structural view, or undefined when no turn has assembled a
   *  prompt yet. Absent ⇒ `/context` falls back to the legacy placeholder. */
  contextUsage: () => import("../status-line").SegmentedUsageView | undefined
  /** Ticket 17 `/agents` — live subagent fleet getter. Read each invocation so
   *  the panel reflects the CURRENT registry. Absent ⇒ `/agents` prints "not
   *  wired in this surface". */
  agents: () => readonly import("../agents-fleet-panel").AgentFleetRow[]
  /** RFC-01 A4 `/attention` — the live pending-question navigation wire (list /
   *  next / answer). Present iff `QUANTA_ATTENTION_NAV` composed the authorities;
   *  absent ⇒ `/attention` prints "not wired". The `focus-next-attention`
   *  KEY_ACTION hook reads the SAME wire. */
  attention: import("../slash/attention-cmd").AttentionSlashState
  /** RFC-06 F5 `/skill` — the per-skill copy/reveal/enable/disable wire over the
   *  SAME live F1 authority + action ports. Present iff `QUANTA_SKILL_ACTIONS`
   *  composed them; absent ⇒ `/skill` prints "not wired". */
  skillActions: import("../slash/skill").SkillActionsState
  /** jun-15 P0-b `/activity` — the session Activity Spine store (shared with the
   *  loop's `run_workflow` writer). Absent ⇒ ephemeral fleet-only view. */
  activityStore: import("@/activity").ActivityStore
  /** S2 unified-observability (jul-03) `/activity` — the item-stream sink the
   *  fleet snapshot is ALSO pumped onto (under `QUANTA_ITEM_STREAM`), so the
   *  subagent lifecycle folds into the ONE item taxonomy the wire planes carry.
   *  Absent ⇒ no pump (the CLI has no wire plane; byte-identical). The GATE lives
   *  in `pumpFleetRowsToItemStream`, so even a present sink is inert when the flag
   *  is off. */
  itemStreamSink: import("@/shared").ItemStreamSink
  /** S2 (jul-03) `/activity` — read-only snapshot of the bounded ItemStore the
   *  fleet snapshot is pumped into (the SAME store `itemStreamSink` captures onto).
   *  Absent ⇒ `/activity` omits the "Subagent items" section. */
  activityItems: () => readonly import("./item-store").RetainedItem[]
  /** A3 (jul-03) `/kb` — read-only Projects knowledge-base accounting getter (the
   *  `knowledge{}` byte budget + doc count). Absent ⇒ `/kb` prints "not wired". */
  projectsKb: import("../slash/kb-cmd").KbSlashState
  /** B4 (jul-03) `/mcp-resources` — read-only fetched-resource-dir + blob-path
   *  capture snapshot. Absent ⇒ `/mcp-resources` prints "not wired". */
  mcpResources: () => readonly import("../slash/mcp-resources-cmd").McpResourceDirRecord[]
  /** S1 (jul-03) `/browser-net` — last network-capture + locator summary getter.
   *  Absent ⇒ `/browser-net` prints "not wired". */
  browserNet: () => import("../slash/browser-net-cmd").BrowserNetSnapshot | undefined
  /** B2 (jul-03) `/cron` — the automation-engine slash wire (list/create/inbox).
   *  Absent ⇒ `/cron` + `/inbox` print "not wired". */
  automation: import("../slash/cron-cmd").AutomationSlashState
  /** ADR-0231 `/radar` — the live radar proposal-queue store (SAME instance the
   *  loop's producer hook writes). Absent ⇒ `/radar` prints "not wired". */
  radar: import("@/radar").RadarStore
  /** ADR-0231 — `/radar prune` cutoff (ms). Absent ⇒ command defaults to 24h. */
  radarPruneOlderThanMs: number
}>

export interface BuildReplSlashCtxArgs {
  skillsCb: (() => Promise<SkillRow[]>) | undefined
  /** RFC-06 F4 — `/reload-skills` authority-backed hook (sync + revision).
   *  Absent ⇒ `/reload-skills` falls back to {@link skillsCb} (pre-F4 re-scan). */
  reloadSkillsCb?: (() => Promise<{ rows: SkillRow[]; revision?: number }>) | undefined
  idleMonitor: IdleMonitor
  /** F1a — the session's repo-rules snapshot, forwarded to `/rules`. */
  repoRules?: import("@/agent").RepoRules | undefined
  imageQueue: ImageQueue | undefined
  rewindState: RewindSlashState | undefined
  mcpSurface: McpSurfaceInfo | undefined
  costPanel: CostPanel | undefined
  planStore: PlanStore | undefined
  branchProgress: BranchProgressTracker | undefined
  /** Ticket 17 `/agents` — the session's lifecycle subagent registry. The
   *  surface threads `setup.lifecycleTaskRegistry`; absent/omitted ⇒ the `agents`
   *  ctx slot is omitted and `/agents` prints "not wired" (default-OFF
   *  byte-identical). Optional so existing call sites/tests need no change. */
  taskRegistry?: import("@/subagent").TaskRegistry | undefined
  /** RFC-01 A4 `/attention` — the live pending-question navigation wire (list /
   *  next / answer), built by the surface from A2's `AttentionReader` + the
   *  `UserQuestionBroker`. Present iff `QUANTA_ATTENTION_NAV` composed them;
   *  absent/omitted ⇒ the `attention` ctx slot is omitted and `/attention` prints
   *  "not wired" (default-OFF byte-identical). */
  attention?: import("../slash/attention-cmd").AttentionSlashState | undefined
  /** RFC-06 F5 `/skill` — the per-skill copy/reveal/enable/disable wire over the
   *  SAME live F1 authority + action ports. Present iff `QUANTA_SKILL_ACTIONS`
   *  composed them; absent/omitted ⇒ the `skillActions` ctx slot is omitted and
   *  `/skill` prints "not wired" (default-OFF byte-identical). */
  skillActions?: import("../slash/skill").SkillActionsState | undefined
  /** jun-15 P0-b `/activity` — session Activity Spine store (shared with the
   *  loop's `run_workflow` writer). Absent ⇒ `/activity` falls back to an
   *  ephemeral fleet-only view. */
  activityStore?: import("@/activity").ActivityStore | undefined
  /** S2 unified-observability (jul-03) `/activity` — the item-stream sink the
   *  fleet snapshot is pumped onto. Threaded ONLY when `QUANTA_ITEM_STREAM` is on
   *  AND a wire-plane sink exists (composition-root presence-gate). Absent ⇒ no
   *  pump (byte-identical). */
  itemStreamSink?: import("@/shared").ItemStreamSink | undefined
  /** S2 (jul-03) `/activity` — the bounded ItemStore snapshot getter. Threaded
   *  ONLY when `QUANTA_ITEM_STREAM` is on (same gate as `itemStreamSink`). */
  activityItems?: (() => readonly import("./item-store").RetainedItem[]) | undefined
  /** A3 (jul-03) `/kb` — Projects knowledge-base accounting wire. Threaded ONLY
   *  when `QUANTA_PROJECTS_KB` is on AND the store is reachable. */
  projectsKb?: import("../slash/kb-cmd").KbSlashState | undefined
  /** B4 (jul-03) `/mcp-resources` — fetched-dir + blob-path capture snapshot. */
  mcpResources?:
    | (() => readonly import("../slash/mcp-resources-cmd").McpResourceDirRecord[])
    | undefined
  /** S1 (jul-03) `/browser-net` — last network-capture + locator summary getter. */
  browserNet?: (() => import("../slash/browser-net-cmd").BrowserNetSnapshot | undefined) | undefined
  /** B2 (jul-03) `/cron` — automation-engine slash wire. Threaded ONLY when
   *  `QUANTA_AUTOMATION` is on AND the engine is reachable. */
  automation?: import("../slash/cron-cmd").AutomationSlashState | undefined
  /** ADR-0231 `/radar` — the gated radar proposal-queue store. Surface-compose
   *  threads the SAME instance it wires into `AgentConfig.radar.store` ONLY when
   *  `QUANTA_RADAR` is on; absent/omitted ⇒ the `radar` ctx slot is omitted and
   *  `/radar` prints "not wired" (default-OFF byte-identical). */
  radar?: import("@/radar").RadarStore | undefined
  /** ADR-0231 — `/radar prune` cutoff (ms). Absent ⇒ command defaults to 24h. */
  radarPruneOlderThanMs?: number | undefined
  /** Returns the live transcript reference so slash surfaces never read a
   *  stale `history` binding. */
  getHistory: () => readonly Message[]
  /** Runtime-owned side-conversation starter. Surface-compose injects a live
   *  getter-backed closure so `/side` sees the current runtime session method
   *  instead of a stale or pre-session binding. Resolves the typed
   *  `"not-wired"` marker when the wire is absent (UUX-1-23 — the old
   *  hard-throw is gone; consumers render the D-6 posture). */
  startSideConversation: (
    args: RuntimeSideConversationArgs,
  ) => Promise<RuntimeSideConversationResult | import("../side-cmd").SideStartUnwired>
  /** Live runtime-side availability probe. */
  isSideConversationWired: () => boolean
  abortSignal: AbortSignal
  /** ADR-0239 — debug-tracer surface handle. Absent ⇒ `/debug` prints
   *  "not wired" (boot-time tee was not allocated). */
  debugHandle: DebugTracerHandle | undefined
  /** ADR-0271 — active LLMPort for the `/why` meta-LLM reasoning query.
   *  Threaded straight from `SessionSetupResult.llm`. */
  llm: LLMPort
  /** ADR-0271 — active session id (envelope reader scope). */
  sessionId: string
  /** ADR-0271 — model identifier surfaced in the `/why` panel header. */
  model: string
  /** Track I — active session id for `/inspect`. Absent ⇒ command
   *  prints "no active session" + exit 1. */
  inspect: InspectSlashState | undefined
  /** Track R — `/replay` resolver+iterator pair. Absent ⇒ command
   *  prints "not wired in this surface" + exit 0. */
  replay: ReplaySlashState | undefined
  /** Session-level reasoning-effort wire — `get` reads the surface-owned
   *  `EffortStore`, `set` mutates BOTH the store and any chrome (status
   *  pill) the surface paints. Required in the REPL surface (no degrade). */
  effort: {
    readonly get: () => import("@/agent").EffortLevel
    readonly set: (level: import("@/agent").EffortLevel) => void
    readonly levels: readonly import("@/agent").EffortLevel[]
    readonly budgetTokens: (level: import("@/agent").EffortLevel) => number | undefined
  }
  /** #17 (C3) — `/brief` session-posture wire. `get` reads the surface-owned
   *  `BriefStore`; `set` mutates it (the loop reads the SAME cell via
   *  `AgentConfig.sessionBrief`). Optional so test/headless constructors that
   *  predate the slot still compile; absent ⇒ `/brief` prints "not wired in this
   *  surface" (byte-identical). The live REPL surface always wires it. */
  brief?: {
    readonly get: () => boolean
    readonly set: (on: boolean) => void
  }
  /** ADR-0291 — `/edit-plan`: REPL surface owns the mutable text. When
   *  omitted, the slash prints "not wired in this surface". */
  composerHandle?: ComposerHandle | undefined
  /** ADR-0291 — `/fork-checkpoint`: in-memory ConversationCheckpointStore
   *  for the rich `defaultForker`. Absent ⇒ slot omitted. */
  conversationStore?: ConversationCheckpointStore | undefined
  /** ADR-0291 — `/rewind-tool`: granular registry + (optional) real
   *  three-way restore port. When `restorePort` is absent, the adapter
   *  fills with a typed not-yet-wired stub so the slash still resolves
   *  tag prefixes against the registry. */
  perToolRegistry?: GranularRegistry | undefined
  perToolRestorePort?: ThreeWayRestorePort | undefined
  /** RFC-def `/undo` — the durable hunk-mutation journal store. Threaded ONLY
   *  when `QUANTA_HUNK_UNDO=1` (the composition root built the store); absent ⇒
   *  the `hunkUndo` ctx slot is omitted and `/undo` prints "not wired"
   *  (default-OFF byte-identical). */
  hunkUndoStore?: import("@/runner/hunk-mutation-journal").HunkMutationJournalStore | undefined
  /** UUX-6-03 — the ONE live-history swap seam for `/rewind-tool`'s task
   *  leg (same closure `/rewind-conv` + `/rewind` swap through). Absent ⇒
   *  the command keeps its prior print-only behavior. */
  perToolReplaceMessages?: ((msgs: ReadonlyArray<Message>) => Promise<void>) | undefined
  /** ADR-0291 — `/profile`: authoritative session-owned tool-profile state. */
  toolProfileState?: ToolProfileSessionState | undefined
  /** Back-compat alias for older tests/callers; prefer `toolProfileState`. */
  toolProfile?:
    | { readonly resolver: ToolProfileResolver; readonly defaultName?: ToolProfileName }
    | undefined
  /** ADR-0291 — `/identity`: authoritative session-owned identity state. */
  identityModeState?: IdentityModeSessionState | undefined
  /** Back-compat alias for older tests/callers; prefer `identityModeState`. */
  identityModeVariant?:
    | {
        readonly registry: SystemPromptVariantRegistry
        readonly defaultMode?: import("@/agent/system-prompt").ModeVariantKey
      }
    | undefined
  /** ADR-0302 — refresh any derived system source after identity changes. */
  onIdentityModeChange?: (() => void) | undefined
  /** ADR-0462 — `/sticky-model`: fs-backed per-mode model store. Absent ⇒
   *  the `/sticky-model` slot is omitted (slash prints "not wired"). */
  stickyModelStore?: StickyModelStore | undefined
  /** ADR-0462 — known model ids for `<modelId>` tab-completion (current model +
   *  configured candidates, deduped by the caller). Convenience only. */
  stickyModelCandidateIds?: readonly string[] | undefined
  /** ADR-0291 — `/focus-chain`: authoritative session-owned tracker slot. */
  focusChain?: { readonly tracker: FocusChainPort; readonly reinjectEveryN?: number } | undefined
  /** Back-compat alias for older tests/callers; prefer `focusChain`. */
  focusChainTracker?: FocusChainPort | undefined
  /** ADR-0291 — `/web`: surface-owned text inbox sink. Drained by the
   *  next-turn PromptSource.next(). */
  textInbox?: TextInbox | undefined
  /** Track D — `/context`: getter over the surface-retained per-turn prompt
   *  snapshot, returning the segmented usage view (or undefined before the
   *  first turn). Absent ⇒ the `contextUsage` slot is omitted entirely so
   *  `/context` keeps its legacy fallback (default-OFF byte-identical). */
  contextUsage?: (() => import("../status-line").SegmentedUsageView | undefined) | undefined
}

/** Result of {@link buildNewSlotAdapters} — each field is either the built
 *  adapter or `undefined` when its upstream port was omitted. Kept private
 *  so the surface contract stays the public `ReplSlashCtx`. */
interface NewSlotAdapters {
  readonly planEdit: PlanEditPort | undefined
  readonly composerEdit: ComposerEditPort | undefined
  readonly forkSession: ForkSessionSlashState | undefined
  readonly perToolCheckpoint: PerToolCheckpointSlashState | undefined
  readonly profile: ReturnType<typeof buildToolProfileAdapter> | undefined
  readonly identity: ReturnType<typeof buildIdentityModeAdapter> | undefined
  readonly stickyModel: ReturnType<typeof buildStickyModelAdapter> | undefined
  readonly focusChain: ReturnType<typeof buildFocusChainAdapter> | undefined
  readonly textInbox: TextInbox | undefined
  readonly hunkUndo: import("../undo-cmd").HunkUndoSlashState | undefined
}

/** Build the fork-session adapter when wired; otherwise undefined. */
const maybeForkSession = (args: BuildReplSlashCtxArgs): ForkSessionSlashState | undefined => {
  if (args.conversationStore === undefined) return undefined
  const sid = args.sessionId
  return buildForkSessionAdapter({
    conversationStore: args.conversationStore,
    ...(typeof sid === "string" && sid.length > 0 ? { activeSessionId: sid } : {}),
  })
}

/** Build the per-tool-checkpoint adapter when wired; otherwise undefined. */
const maybePerToolCheckpoint = (
  args: BuildReplSlashCtxArgs,
): PerToolCheckpointSlashState | undefined => {
  if (args.perToolRegistry === undefined) return undefined
  return buildPerToolCheckpointAdapter({
    registry: args.perToolRegistry,
    ...(args.perToolRestorePort !== undefined ? { restore: args.perToolRestorePort } : {}),
    ...(args.perToolReplaceMessages !== undefined
      ? { replaceMessages: args.perToolReplaceMessages }
      : {}),
  })
}

/** Build the tool-profile adapter when wired; otherwise undefined. */
const maybeProfile = (
  args: BuildReplSlashCtxArgs,
): ReturnType<typeof buildToolProfileAdapter> | undefined => {
  const tp = args.toolProfileState
  const legacy = args.toolProfile
  if (tp === undefined && legacy === undefined) return undefined
  let active = legacy?.defaultName ?? "write"
  return buildToolProfileAdapter({
    getActive: () => tp?.get() ?? active,
    setActive: (name) => {
      if (tp !== undefined) tp.set(name)
      else active = name
    },
  })
}

/** Build the identity-mode adapter when wired; otherwise undefined. */
const maybeIdentity = (
  args: BuildReplSlashCtxArgs,
): ReturnType<typeof buildIdentityModeAdapter> | undefined => {
  const im = args.identityModeState
  const legacy = args.identityModeVariant
  if (im === undefined && legacy === undefined) return undefined
  let active: IdentityMode = legacy?.defaultMode ?? "default"
  return buildIdentityModeAdapter({
    registry: im?.registry ??
      legacy?.registry ?? { variantFor: () => ({ mode: "default", identity: [] }) },
    getActive: () => im?.get() ?? active,
    setActive: (mode) => {
      if (im !== undefined) im.set(mode)
      else active = mode
    },
    ...(args.onIdentityModeChange !== undefined
      ? { onChange: () => args.onIdentityModeChange?.() }
      : {}),
    // B1 (jul-03) — make the identity-only `onboarding` virtual mode reachable
    // mid-session via `/identity onboarding` + `/onboard`. The adapter routes it
    // through this hook (NOT the ModeVariantKey registry). The hook triggers the
    // SAME prompt-rebuild the ModeVariantKey path uses so the next turn's system
    // prompt reflects the change. Only offered when a rebuild seam is wired
    // (byte-identical to the pre-B1 ship when absent).
    ...(args.onIdentityModeChange !== undefined
      ? {
          onOnboarding: () => {
            if (im !== undefined) im.set(ONBOARDING_IDENTITY_KEY)
            else active = ONBOARDING_IDENTITY_KEY
            args.onIdentityModeChange?.()
          },
        }
      : {}),
  })
}

/** Build the sticky-model adapter when a store is wired; otherwise undefined. */
const maybeStickyModel = (
  args: BuildReplSlashCtxArgs,
): ReturnType<typeof buildStickyModelAdapter> | undefined => {
  if (args.stickyModelStore === undefined) return undefined
  return buildStickyModelAdapter({
    store: args.stickyModelStore,
    ...(args.stickyModelCandidateIds !== undefined
      ? { candidateIds: args.stickyModelCandidateIds }
      : {}),
  })
}

/** Build the ADR-0291 adapters. Pure / no side effects; each gate is
 *  presence-only so omitting an upstream port omits the corresponding
 *  ctx slot (default-OFF byte-identical). Extracted from
 *  {@link buildReplSlashCtx} so each function stays under biome's
 *  cognitive-complexity ceiling. */
const buildNewSlotAdapters = (args: BuildReplSlashCtxArgs): NewSlotAdapters => ({
  planEdit: args.planStore !== undefined ? buildPlanEditAdapter(args.planStore) : undefined,
  composerEdit:
    args.composerHandle !== undefined ? buildComposerEditAdapter(args.composerHandle) : undefined,
  forkSession: maybeForkSession(args),
  perToolCheckpoint: maybePerToolCheckpoint(args),
  profile: maybeProfile(args),
  identity: maybeIdentity(args),
  stickyModel: maybeStickyModel(args),
  focusChain:
    args.focusChain !== undefined
      ? buildFocusChainAdapter(args.focusChain.tracker)
      : args.focusChainTracker !== undefined
        ? buildFocusChainAdapter(args.focusChainTracker)
        : undefined,
  textInbox: args.textInbox,
  // RFC-def `/undo` — presence-gated: the slot exists ONLY when the composition
  // root built the durable journal store (⇒ `QUANTA_HUNK_UNDO=1`). Absent ⇒
  // `/undo` prints "not wired" (byte-identical). The store is the SAME instance
  // the HITL prompt persists applies into, so `/undo` lists exactly what landed.
  hunkUndo: args.hunkUndoStore !== undefined ? { store: args.hunkUndoStore } : undefined,
})

/** Spread the ADR-0291 adapter fields into the surface ctx. Pure / 1:1
 *  fan-out — kept separate from {@link buildReplSlashCtx} for the same
 *  cognitive-complexity reason as {@link buildNewSlotAdapters}. */
const spreadNewSlots = (s: NewSlotAdapters): Partial<ReplSlashCtx> => ({
  ...(s.planEdit !== undefined ? { planEdit: s.planEdit } : {}),
  ...(s.composerEdit !== undefined ? { composerEdit: s.composerEdit } : {}),
  ...(s.forkSession !== undefined ? { forkSession: s.forkSession } : {}),
  ...(s.perToolCheckpoint !== undefined ? { perToolCheckpoint: s.perToolCheckpoint } : {}),
  ...(s.profile !== undefined ? { profile: s.profile } : {}),
  ...(s.identity !== undefined ? { identity: s.identity } : {}),
  ...(s.stickyModel !== undefined ? { stickyModel: s.stickyModel } : {}),
  ...(s.focusChain !== undefined ? { focusChain: s.focusChain } : {}),
  ...(s.textInbox !== undefined ? { textInbox: s.textInbox } : {}),
  ...(s.hunkUndo !== undefined ? { hunkUndo: s.hunkUndo } : {}),
})

/** Project a `@/subagent` TaskRecord into the surface's structural
 *  {@link import("../agents-fleet-panel").AgentFleetRow} — drops the heavy
 *  `result.messages`, carries the optional fields with presence-spread
 *  (exactOptionalPropertyTypes). Keeps the panel decoupled from `@/subagent`
 *  internals (the surface owns the mapping seam). */
/** Scrub secrets out of an untrusted subagent string before it reaches the
 *  `/agents` UI. The CLI reads RAW `TaskRecord`s from `TaskRegistry.list()` (a
 *  DIFFERENT path from the redacted event stream the web panel consumes), so a
 *  child that echoes a key into its description / final response / error would
 *  otherwise print it verbatim (hellaudit HIGH, 2026-07-15). `redactValue` is
 *  the same SoT the registry emit boundary uses. */
export const scrubAgentText = (s: string): string => redactValue(s) as string

export const toAgentFleetRow = (
  r: import("@/subagent").TaskRecord,
): import("../agents-fleet-panel").AgentFleetRow => ({
  id: r.id,
  description: scrubAgentText(r.description),
  status: r.status,
  startedAt: r.startedAt,
  ...(r.agentType !== undefined ? { agentType: r.agentType } : {}),
  ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
  ...(r.error !== undefined ? { error: scrubAgentText(r.error) } : {}),
  ...(r.result !== undefined
    ? {
        result: {
          ok: r.result.ok,
          finalText: scrubAgentText(r.result.finalText),
          turns: r.result.turns,
        },
      }
    : {}),
  // Lineage edges — the spawn TREE that `/agents --tree` reconstructs.
  ...(r.parentTaskId !== undefined ? { parentTaskId: r.parentTaskId } : {}),
  ...(r.depth !== undefined ? { depth: r.depth } : {}),
  ...(r.mailboxLabel !== undefined ? { mailboxLabel: r.mailboxLabel } : {}),
})

/** jul-03 CLI-surfacing — the S2/A3/B4/S1/B2 read-only ctx slots, grouped so
 *  {@link buildReplSlashCtx} spreads ONE presence-gated set and stays under
 *  biome's cognitive-complexity budget. It had a SECOND caller once — a
 *  hand-enumerated live-path projector — and this comment described keeping the
 *  two in sync; that function is gone, the live path funnels through
 *  {@link projectSlashCtx}, and these five slots are projected individually
 *  there like every other slot. One call site remains, in the builder.
 *  The input allows `| undefined` on each field (the builder passes destructured
 *  args) — erased by the presence spread under `exactOptionalPropertyTypes`. */
type SurfacedSlots = Pick<
  ReplSlashCtx,
  "activityItems" | "projectsKb" | "mcpResources" | "browserNet" | "automation"
>
/**
 * Presence-spread: `{ [key]: value }` when `value` is defined, else `{}`.
 *
 * ONE unit standing in for the ~45 `...(x !== undefined ? { k: x } : {})`
 * ternaries that {@link buildReplSlashCtx} and the two hand-enumerated projectors
 * it has since replaced used to spell out. Under `exactOptionalPropertyTypes` an
 * unwired slot must be an ABSENT KEY (not a key holding `undefined`) — that is
 * the whole rule, and repeating it per slot was the entirety of those functions'
 * cognitive-complexity score.
 *
 * Key ORDER is NOT something this preserves, and an earlier version of this
 * comment claimed it did. The ctx {@link buildReplSlashCtx} returns still follows
 * its own literal spread order, but {@link projectSlashCtx} emits in
 * {@link SLOT_PROJECTORS} declaration order — `side` is declared 14th on
 * `ReplSlashCtx` and projected 2nd. Nothing reads that order: every consumer
 * reaches slots by name, and the one test that walks a built ctx (`HELL-WIRE-18`)
 * checks each VALUE, never the sequence.
 */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? ({} as { [P in K]?: V }) : ({ [key]: value } as { [P in K]?: V })

type SurfacedSlotsInput = { [K in keyof SurfacedSlots]?: SurfacedSlots[K] | undefined }
const spreadSurfacedSlots = (s: SurfacedSlotsInput): Partial<SurfacedSlots> => ({
  ...(s.activityItems !== undefined ? { activityItems: s.activityItems } : {}),
  ...(s.projectsKb !== undefined ? { projectsKb: s.projectsKb } : {}),
  ...(s.mcpResources !== undefined ? { mcpResources: s.mcpResources } : {}),
  ...(s.browserNet !== undefined ? { browserNet: s.browserNet } : {}),
  ...(s.automation !== undefined ? { automation: s.automation } : {}),
})

export const buildReplSlashCtx = (args: BuildReplSlashCtxArgs): ReplSlashCtx => {
  const {
    skillsCb,
    reloadSkillsCb,
    idleMonitor,
    repoRules,
    imageQueue,
    rewindState,
    mcpSurface,
    costPanel,
    planStore,
    branchProgress,
    getHistory,
    startSideConversation,
    isSideConversationWired,
    abortSignal,
    debugHandle,
    llm,
    sessionId,
    model,
    inspect,
    replay,
    effort,
    brief,
    contextUsage,
    taskRegistry,
    attention,
    skillActions,
    activityStore,
    itemStreamSink,
    activityItems,
    projectsKb,
    mcpResources,
    browserNet,
    automation,
    radar,
    radarPruneOlderThanMs,
  } = args
  const newSlots = buildNewSlotAdapters(args)
  // The five slots whose VALUE is a closure over an optional port stay as
  // whole-SLOT objects rather than `opt(key, fn)`: an arrow written as an
  // object-property value inherits that key as its `Function.name`, and an
  // arrow bound to a `const` through a ternary does not. Same one gate each,
  // and the slot's identity is preserved exactly.
  const costSlot = costPanel === undefined ? {} : { cost: () => costPanel.renderDetailed() }
  const planSnapshotSlot =
    planStore === undefined
      ? {}
      : { planSnapshot: (): import("@/agent/plan/types").Plan | null => planStore.current() }
  const branchSearchSlot =
    branchProgress === undefined ? {} : { branchSearch: () => branchProgress.snapshot() }
  // Ticket 17 — `/agents` live fleet getter, read each invocation off the
  // session registry. Absent registry ⇒ slot omitted ⇒ `/agents` "not wired".
  const agentsSlot =
    taskRegistry === undefined ? {} : { agents: () => taskRegistry.list().map(toAgentFleetRow) }
  // RFC02-1 — `/ps` owner-scoped background-shell inventory. Wired ONLY when
  // QUANTA_PROC_PANEL is on (same gate as the command registration). Reads the
  // LIVE singleton registry each invocation, scoped to THIS session's owner
  // (`sessionId`) via `listOwned`, and projects ONLY the redaction-safe fields
  // (command/cwd/output are never read). Absent gate ⇒ slot omitted ⇒ `/ps`
  // prints "not wired" (and is not even registered) — byte-identical when OFF.
  const procShellsSlot = isProcPanelEnabled()
    ? {
        procShells: (): readonly ProcPanelRow[] =>
          getBashBgRegistry()
            .listOwned(sessionId)
            .map((s) => ({
              id: s.id,
              status: s.status,
              startedAt: s.startedAt,
              exitCode: s.exitCode,
            })),
      }
    : {}
  return {
    ...opt("skills", skillsCb),
    ...opt("reloadSkills", reloadSkillsCb),
    idle: idleMonitor,
    ...opt("repoRules", repoRules),
    ...opt("imageQueue", imageQueue),
    ...opt("rewindSession", rewindState),
    ...opt("mcp", mcpSurface),
    ...costSlot,
    ...planSnapshotSlot,
    ...branchSearchSlot,
    history: { messages: getHistory },
    side: (): SideCmdSlashState => ({
      start: async ({ question, inherit, tools, maxTurns, signal }) =>
        await startSideConversation({
          question,
          signal,
          ...opt("inherit", inherit),
          ...opt("tools", tools),
          ...opt("maxTurns", maxTurns),
        }),
      isWired: isSideConversationWired,
      signal: abortSignal,
    }),
    // ADR-0239 — `/debug` runtime toggle. Absent ⇒ slash prints "not wired".
    ...opt("debug", debugHandle),
    // ADR-0271 — `/why` meta-LLM reasoning query. Always wired in the
    // REPL surface (LLM + sessionId are required for the loop to start).
    why: { sessionId, llm, model },
    // Track I — `/inspect` active session wire. Absent ⇒ slash exits 1.
    ...opt("inspect", inspect),
    // Track R — `/replay` resolver+iterator. Absent ⇒ slash prints "not wired".
    ...opt("replay", replay),
    // Session-level reasoning-effort. Closes over the surface's EffortStore
    // (read on `/effort` no-arg) and pill (repainted on `/effort <level>`).
    effort,
    // #17 (C3) — `/brief` posture wire over the surface's BriefStore (the loop
    // reads the SAME cell via AgentConfig.sessionBrief). Presence-spread so an
    // absent slot omits `/brief` (byte-identical "not wired").
    ...opt("brief", brief),
    // Track D — `/context` live segmented usage. Absent upstream getter ⇒ slot
    // omitted (default-OFF byte-identical; `/context` keeps its fallback).
    ...opt("contextUsage", contextUsage),
    ...agentsSlot,
    // RFC-01 A4 — `/attention` list/next/answer over the SAME broker + registry
    // A2 assembled. Absent slot ⇒ `/attention` "not wired" (byte-identical).
    ...opt("attention", attention),
    // RFC-06 F5 — `/skill` copy/reveal/enable/disable over the SAME live F1
    // authority + action ports. Absent slot ⇒ `/skill` "not wired"
    // (byte-identical when QUANTA_SKILL_ACTIONS is off).
    ...opt("skillActions", skillActions),
    ...procShellsSlot,
    // ADR-0231 — `/radar` live store + prune cutoff. Absent store ⇒ slot
    // omitted ⇒ `/radar` "not wired" (default-OFF byte-identical).
    ...opt("activityStore", activityStore),
    ...opt("itemStreamSink", itemStreamSink),
    // jul-03 CLI-surfacing — S2/A3/B4/S1/B2 read-only slots (extracted helper so
    // this function stays under biome's cognitive-complexity budget; each is
    // presence-gated so an absent upstream port omits the ctx slot ⇒ the slash
    // prints "not wired" / omits its section; default-OFF byte-identical).
    ...spreadSurfacedSlots({
      activityItems,
      projectsKb,
      mcpResources,
      browserNet,
      automation,
    }),
    ...opt("radar", radar),
    ...opt("radarPruneOlderThanMs", radarPruneOlderThanMs),
    // ADR-0291 — 8 new slots; each gated by presence so omitting an
    // upstream port produces a byte-identical "not wired" projection.
    ...spreadNewSlots(newSlots),
  }
}

/** One slot's contribution to the contract shape. Absent ⇒ `{}` ⇒ the key is
 *  omitted, which is what every "not wired in this surface" message reads. */
type SlotProjector = (s: ReplSlashCtx) => Record<string, unknown>

/**
 * EXHAUSTIVE BY CONSTRUCTION. Typed `Record<keyof ReplSlashCtx, …>`, so a slot
 * declared on the ctx and left out of this table is a COMPILE error that NAMES
 * the missing key (`Property 'attention' is missing in type …`).
 *
 * This replaces a hand-enumerated spread. Under that shape a slot could be
 * declared on the ctx, assigned by the builder, and silently dropped here with
 * nothing failing — which is exactly how `/attention` shipped printing "not
 * wired" in every session while the `focus-next-attention` chord, which reads
 * `slashCtx.attention` without going through this projection, worked fine.
 *
 * `cwd` is the ONE deliberate non-projection: `dispatchReplSlash` reads it
 * directly (`slashCtx?.cwd ?? process.cwd()`) and passes it as its own
 * argument, so it is not part of the contract shape. It still needs an entry
 * here — the table is total, and "excluded" has to be stated, not omitted.
 */
const SLOT_PROJECTORS: Readonly<Record<keyof ReplSlashCtx, SlotProjector>> = {
  // Not a contract-shape slot — see the note above.
  cwd: () => ({}),
  procShells: (s) => opt("procShells", s.procShells),
  // `/side` is a FACTORY on the ctx and a VALUE in the contract shape: it is
  // built fresh per invocation so the starter sees the live transcript rather
  // than a snapshot captured when the REPL started.
  side: (s) => (s.side !== undefined ? { side: s.side() } : {}),
  skills: (s) => opt("skills", s.skills),
  reloadSkills: (s) => opt("reloadSkills", s.reloadSkills),
  idle: (s) => opt("idle", s.idle),
  repoRules: (s) => opt("repoRules", s.repoRules),
  imageQueue: (s) => opt("imageQueue", s.imageQueue),
  rewindSession: (s) => opt("rewindSession", s.rewindSession),
  mcp: (s) => opt("mcp", s.mcp),
  cost: (s) => opt("cost", s.cost),
  planSnapshot: (s) => opt("planSnapshot", s.planSnapshot),
  history: (s) => opt("history", s.history),
  branchSearch: (s) => opt("branchSearch", s.branchSearch),
  debug: (s) => opt("debug", s.debug),
  why: (s) => opt("why", s.why),
  inspect: (s) => opt("inspect", s.inspect),
  replay: (s) => opt("replay", s.replay),
  effort: (s) => opt("effort", s.effort),
  brief: (s) => opt("brief", s.brief),
  contextUsage: (s) => opt("contextUsage", s.contextUsage),
  agents: (s) => opt("agents", s.agents),
  attention: (s) => opt("attention", s.attention),
  skillActions: (s) => opt("skillActions", s.skillActions),
  activityStore: (s) => opt("activityStore", s.activityStore),
  itemStreamSink: (s) => opt("itemStreamSink", s.itemStreamSink),
  radar: (s) => opt("radar", s.radar),
  radarPruneOlderThanMs: (s) => opt("radarPruneOlderThanMs", s.radarPruneOlderThanMs),
  activityItems: (s) => opt("activityItems", s.activityItems),
  projectsKb: (s) => opt("projectsKb", s.projectsKb),
  mcpResources: (s) => opt("mcpResources", s.mcpResources),
  browserNet: (s) => opt("browserNet", s.browserNet),
  automation: (s) => opt("automation", s.automation),
  planEdit: (s) => opt("planEdit", s.planEdit),
  composerEdit: (s) => opt("composerEdit", s.composerEdit),
  forkSession: (s) => opt("forkSession", s.forkSession),
  perToolCheckpoint: (s) => opt("perToolCheckpoint", s.perToolCheckpoint),
  profile: (s) => opt("profile", s.profile),
  identity: (s) => opt("identity", s.identity),
  stickyModel: (s) => opt("stickyModel", s.stickyModel),
  focusChain: (s) => opt("focusChain", s.focusChain),
  textInbox: (s) => opt("textInbox", s.textInbox),
  hunkUndo: (s) => opt("hunkUndo", s.hunkUndo),
}

/** Map the surface-owned {@link ReplSlashCtx} into the contract shape that
 *  {@link runSlashCommand} expects. Extracted from {@link dispatchReplSlash}
 *  so the dispatcher stays under biome's cognitive-complexity budget —
 *  every adapter is a 1:1 spread, no branching beyond "absent ⇒ omit".
 *
 *  SSOT — this is the ONE projector both the test-harness {@link dispatchReplSlash}
 *  AND the live REPL path (`buildSurfaceDispatch` in `surface-compose.ts`)
 *  funnel through. `surface-compose.ts` imports this and layers its
 *  ADR-0292/0294 augmentations (`convCheckpoint`, `sessionIo`, …) on top, so
 *  the legacy + ADR-0291 slot projection can never drift out of byte-sync
 *  between the two files. */
export const projectSlashCtx = (slashCtx: ReplSlashCtx | undefined): Record<string, unknown> => {
  if (slashCtx === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const project of Object.values(SLOT_PROJECTORS)) Object.assign(out, project(slashCtx))
  return out
}

/** Try to handle `input` as an in-REPL slash command. Returns true iff the
 *  input was routed and consumed by the slash surface; false means the
 *  caller must forward it to the model path. `isSlashCommand` rejects path-
 *  like strings so legacy file-resume tokens still fall through. */
export const dispatchReplSlash = async (
  input: string,
  slashCtx?: ReplSlashCtx,
): Promise<boolean> => {
  const head = input.split(/\s+/)[0] ?? ""
  if (!isSlashCommand(head)) return false
  const cwd = slashCtx?.cwd ?? process.cwd()
  if (head === "/image" && slashCtx?.imageQueue !== undefined) {
    runImageCmd(input, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd,
      queue: slashCtx.imageQueue,
    })
    return true
  }
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd,
    ...projectSlashCtx(slashCtx),
  })
  return true
}

import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { FocusChainPort } from "@/agent/focus-chain"
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
import type { RuntimeSideConversationArgs, RuntimeSideConversationResult } from "@/sdk/runtime"
import type { SessionEnvelopeRecord } from "@/session"
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
import type { RewindSlashState } from "../rewind-cmd"
import type { PerToolCheckpointSlashState } from "../rewind-tool-cmd"
import type { SideCmdSlashState } from "../side-cmd"
import { isSlashCommand, runSlashCommand, type SkillRow } from "../slash-commands"
import type { TextInbox } from "../text-inbox"
import type { WhySlashState } from "../why-cmd"
import { buildComposerEditAdapter, type ComposerHandle } from "./ctx-adapters/composer-edit-adapter"
import { buildFocusChainAdapter } from "./ctx-adapters/focus-chain-adapter"
import { buildForkSessionAdapter } from "./ctx-adapters/fork-session-adapter"
import { buildIdentityModeAdapter } from "./ctx-adapters/identity-mode-adapter"
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
  skills: () => Promise<SkillRow[]>
  idle: IdleMonitor
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
}>

export interface BuildReplSlashCtxArgs {
  skillsCb: (() => Promise<SkillRow[]>) | undefined
  idleMonitor: IdleMonitor
  imageQueue: ImageQueue | undefined
  rewindState: RewindSlashState | undefined
  mcpSurface: McpSurfaceInfo | undefined
  costPanel: CostPanel | undefined
  planStore: PlanStore | undefined
  branchProgress: BranchProgressTracker | undefined
  /** Returns the live transcript reference so slash surfaces never read a
   *  stale `history` binding. */
  getHistory: () => readonly Message[]
  /** Runtime-owned side-conversation starter. Surface-compose injects a live
   *  getter-backed closure so `/side` sees the current runtime session method
   *  instead of a stale or pre-session binding. */
  startSideConversation: (
    args: RuntimeSideConversationArgs,
  ) => Promise<RuntimeSideConversationResult>
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
  let active = legacy?.defaultMode ?? "default"
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
  })
}

/** Build the sticky-model adapter when a store is wired; otherwise undefined. */
const maybeStickyModel = (
  args: BuildReplSlashCtxArgs,
): ReturnType<typeof buildStickyModelAdapter> | undefined => {
  if (args.stickyModelStore === undefined) return undefined
  return buildStickyModelAdapter({ store: args.stickyModelStore })
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
})

/** Compose the REPL-owned slash adapters into one explicit surface object. */
export const buildReplSlashCtx = (args: BuildReplSlashCtxArgs): ReplSlashCtx => {
  const {
    skillsCb,
    idleMonitor,
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
    contextUsage,
  } = args
  const newSlots = buildNewSlotAdapters(args)
  return {
    ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
    idle: idleMonitor,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    ...(rewindState !== undefined ? { rewindSession: rewindState } : {}),
    ...(mcpSurface !== undefined ? { mcp: mcpSurface } : {}),
    ...(costPanel !== undefined ? { cost: () => costPanel.renderDetailed() } : {}),
    ...(planStore !== undefined
      ? { planSnapshot: (): import("@/agent/plan/types").Plan | null => planStore.current() }
      : {}),
    ...(branchProgress !== undefined ? { branchSearch: () => branchProgress.snapshot() } : {}),
    history: { messages: getHistory },
    side: (): SideCmdSlashState => ({
      start: async ({ question, inherit, tools, maxTurns, signal }) =>
        await startSideConversation({
          question,
          signal,
          ...(inherit !== undefined ? { inherit } : {}),
          ...(tools !== undefined ? { tools } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        }),
      isWired: isSideConversationWired,
      signal: abortSignal,
    }),
    // ADR-0239 — `/debug` runtime toggle. Absent ⇒ slash prints "not wired".
    ...(debugHandle !== undefined ? { debug: debugHandle } : {}),
    // ADR-0271 — `/why` meta-LLM reasoning query. Always wired in the
    // REPL surface (LLM + sessionId are required for the loop to start).
    why: { sessionId, llm, model },
    // Track I — `/inspect` active session wire. Absent ⇒ slash exits 1.
    ...(inspect !== undefined ? { inspect } : {}),
    // Track R — `/replay` resolver+iterator. Absent ⇒ slash prints "not wired".
    ...(replay !== undefined ? { replay } : {}),
    // Session-level reasoning-effort. Closes over the surface's EffortStore
    // (read on `/effort` no-arg) and pill (repainted on `/effort <level>`).
    effort,
    // Track D — `/context` live segmented usage. Absent upstream getter ⇒ slot
    // omitted (default-OFF byte-identical; `/context` keeps its fallback).
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    // ADR-0291 — 8 new slots; each gated by presence so omitting an
    // upstream port produces a byte-identical "not wired" projection.
    ...spreadNewSlots(newSlots),
  }
}

/** Project the pre-ADR-0291 slots. Extracted so each function stays under
 *  biome's cognitive-complexity ceiling. */
const projectLegacySlots = (s: ReplSlashCtx): Record<string, unknown> => ({
  ...(s.skills !== undefined ? { skills: s.skills } : {}),
  ...(s.idle !== undefined ? { idle: s.idle } : {}),
  ...(s.rewindSession !== undefined ? { rewindSession: s.rewindSession } : {}),
  ...(s.mcp !== undefined ? { mcp: s.mcp } : {}),
  ...(s.cost !== undefined ? { cost: s.cost } : {}),
  ...(s.planSnapshot !== undefined ? { planSnapshot: s.planSnapshot } : {}),
  ...(s.history !== undefined ? { history: s.history } : {}),
  ...(s.branchSearch !== undefined ? { branchSearch: s.branchSearch } : {}),
  ...(s.side !== undefined ? { side: s.side() } : {}),
  ...(s.debug !== undefined ? { debug: s.debug } : {}),
  ...(s.why !== undefined ? { why: s.why } : {}),
  ...(s.inspect !== undefined ? { inspect: s.inspect } : {}),
  ...(s.replay !== undefined ? { replay: s.replay } : {}),
  ...(s.effort !== undefined ? { effort: s.effort } : {}),
  ...(s.contextUsage !== undefined ? { contextUsage: s.contextUsage } : {}),
})

/** Project the ADR-0291 slots. 1:1 spread; presence-gated for
 *  exactOptionalPropertyTypes. */
const projectAdr0291Slots = (s: ReplSlashCtx): Record<string, unknown> => ({
  ...(s.planEdit !== undefined ? { planEdit: s.planEdit } : {}),
  ...(s.composerEdit !== undefined ? { composerEdit: s.composerEdit } : {}),
  ...(s.forkSession !== undefined ? { forkSession: s.forkSession } : {}),
  ...(s.perToolCheckpoint !== undefined ? { perToolCheckpoint: s.perToolCheckpoint } : {}),
  ...(s.profile !== undefined ? { profile: s.profile } : {}),
  ...(s.identity !== undefined ? { identity: s.identity } : {}),
  ...(s.stickyModel !== undefined ? { stickyModel: s.stickyModel } : {}),
  ...(s.focusChain !== undefined ? { focusChain: s.focusChain } : {}),
  ...(s.textInbox !== undefined ? { textInbox: s.textInbox } : {}),
})

/** Map the surface-owned {@link ReplSlashCtx} into the contract shape that
 *  {@link runSlashCommand} expects. Extracted from {@link dispatchReplSlash}
 *  so the dispatcher stays under biome's cognitive-complexity budget —
 *  every adapter is a 1:1 spread, no branching beyond "absent ⇒ omit". */
const projectSlashCtx = (slashCtx: ReplSlashCtx | undefined): Record<string, unknown> => {
  if (slashCtx === undefined) return {}
  return { ...projectLegacySlots(slashCtx), ...projectAdr0291Slots(slashCtx) }
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
  if (head === "/image" && slashCtx?.imageQueue !== undefined) {
    runImageCmd(input, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      queue: slashCtx.imageQueue,
    })
    return true
  }
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...projectSlashCtx(slashCtx),
  })
  return true
}

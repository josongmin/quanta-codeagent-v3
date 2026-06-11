import type { ThinClientRoute } from "@/shared"
import type { AgentFleetRow } from "./agents-fleet-panel"
import type { DebugCmdState } from "./debug-cmd"
import type { IdleMonitor } from "./idle-monitor"
import type { RetryWithSessionState } from "./retry-with"
import type { SideCmdSlashState } from "./side-cmd"
import type { VoiceLiveCtx } from "./voice-live-cmd"

export interface SlashContext {
  readonly out: (s: string) => void
  readonly err: (s: string) => void
  readonly cwd: string
  // `| undefined` is explicit on every optional field because the repo runs
  // `exactOptionalPropertyTypes: true` — `{ now: undefined }` and `{}` are
  // different there, and tests pass values that may legitimately be undefined.
  readonly now?: (() => number) | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /** Override the preferences file path (test seam). */
  readonly prefsPath?: string | undefined
  /** Override the preferences-home directory (test seam). When set, takes
   *  precedence over `runtimeConfig().prefsHome` so per-test isolation does
   *  not depend on mutating `process.env.QUANTA_PREFS_HOME` after
   *  `runtimeConfig()` has already validated-and-frozen its snapshot. */
  readonly prefsHome?: string | undefined
  /** ADR-0065 model-swap retry session state. Absent ⇒ `/retry-with` prints
   *  "no model candidates configured" and is a no-op (byte-identical to NOT
   *  registering the command). Injected by the surface — the builtins never
   *  read this field unless the slash itself needs it. */
  readonly retry?: RetryWithSessionState | undefined
  /** Cursor-inspired idle/snooze monitor. Wired by the REPL surface so
   *  `/snooze` and `/resume` mutate the SAME instance the prompt source
   *  consults to refuse new turns. */
  readonly idle?: IdleMonitor | undefined
  /** Re-discover skills from disk on demand so `/skills` and `/reload-skills`
   *  can render the inventory without importing `@/skill` types. */
  readonly skills?: (() => Promise<SkillRow[]>) | undefined
  /** Claude A9 `/side <q>` isolated agent loop. */
  readonly side?: SideCmdSlashState | undefined
  /** Sticky cumulative cost dashboard render seam. */
  readonly cost?: (() => string) | undefined
  /** Track D — segmented context-window usage seam. Returns the breakdown for
   *  the latest assembled prompt (per-category token segments), or undefined
   *  when no prompt has been assembled yet. Wired by the REPL surface; absent ⇒
   *  `/context` falls back to the legacy placeholder line. The view type is the
   *  structural shape the renderer needs (defined in `status-line.ts`, no
   *  `@/agent` import) — `ContextUsageBreakdown` is assignable to it. */
  readonly contextUsage?: (() => import("./status-line").SegmentedUsageView | undefined) | undefined
  /** Read-only plan-store snapshot accessor. */
  readonly planSnapshot?: (() => import("@/agent/plan/types").Plan | null) | undefined
  /** Read-only WorkingState snapshot. */
  readonly workingState?: (() => import("@/agent").WorkingState | undefined) | undefined
  /** ADR-0512 P3 — read-only skill tool-scope projection for `/state` ("왜 이
   *  도구가 없지?"): the CURRENTLY-active skill + the L1 availability filter's
   *  visible/hidden tool partition. A GETTER (read each invocation so it reflects
   *  the live gate, which a mid-turn `Skill` call may have armed). Present ONLY
   *  when `QUANTA_SKILL_SCOPE_V2` is on AND the surface published the getter;
   *  absent OR yielding `undefined`/`activeSkill: null` ⇒ `/state` omits the
   *  skill-scope section (byte-identical to the working-state-only render). */
  readonly skillScope?: (() => import("@/agent").SkillScopeView | undefined) | undefined
  /** Recent turns + tool-call breadcrumb. */
  readonly history?: import("./history-cmd").HistorySessionState | undefined
  /** N-best candidate tracker snapshot. */
  readonly branchSearch?: (() => import("./branch-search-progress").BranchProgressState) | undefined
  /** Tool-profile slash wire. */
  readonly profile?:
    | {
        readonly get: () => string
        readonly set: (
          name: string,
        ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        readonly list: () => readonly string[]
      }
    | undefined
  /** #13 — `/mode` interactive permission-posture wire (RFC-08 mode-cycle).
   *  `get` returns the active rung key; `set` jumps to a named posture and
   *  mutates the SAME `ModeCycleStore` the shift+tab cycle + the session loop's
   *  per-turn `permissionModeState` projection read, so a `/mode acceptEdits`
   *  applies on the NEXT submitted prompt (NOT a direct `permissionModeState`
   *  write, which the projection would clobber). `list` enumerates the rung
   *  keys. Present iff `QUANTA_MODE_CYCLE` is on AND the surface built the store;
   *  absent ⇒ `/mode` prints "not wired in this surface" (byte-identical). */
  readonly mode?:
    | {
        readonly get: () => string
        readonly set: (
          key: string,
        ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        readonly list: () => readonly string[]
      }
    | undefined
  /** Identity-mode slash wire. */
  readonly identity?:
    | {
        readonly get: () => string
        readonly set: (
          mode: string,
        ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        readonly list: () => readonly string[]
      }
    | undefined
  /** ADR-0462 — `/sticky-model <mode> <modelId>` SET wire. Adapter over the
   *  fs-backed `StickyModelStore`. Absent ⇒ `/sticky-model` prints "not wired
   *  in this surface" (byte-identical). The consume side (agent loop) reads the
   *  same on-disk file fresh each turn. */
  readonly stickyModel?:
    | {
        readonly modes: () => readonly string[]
        readonly candidates: () => readonly string[]
        readonly list: () => Promise<Readonly<Record<string, string>>>
        readonly set: (
          mode: string,
          modelId: string,
        ) => Promise<
          | "ok"
          | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
          | { readonly kind: "write-error"; readonly message: string }
        >
      }
    | undefined
  /** Focus-chain slash wire. */
  readonly focusChain?:
    | {
        readonly snapshot: () => {
          readonly todos: ReadonlyArray<{ readonly text: string; readonly state: string }>
          readonly currentTurn: number
          readonly driftWarning: string | null
        }
        readonly reset: () => void
        readonly skip: () => void
      }
    | undefined
  /** Debug-tracer runtime toggle seam. */
  readonly debug?:
    | {
        readonly get: () => DebugCmdState
        readonly set: (state: DebugCmdState) => void
      }
    | undefined
  /** Session-level reasoning-effort wire (Codex `/model`-style UX, effort-
   *  only). `get` returns the current named tier; `set` mutates the surface-
   *  owned store AND updates any chrome (status pills) the surface paints.
   *  Absent ⇒ `/effort` prints "not wired in this surface" (parity with the
   *  rest of the surface-only commands). */
  readonly effort?:
    | {
        readonly get: () => import("@/agent").EffortLevel
        readonly set: (level: import("@/agent").EffortLevel) => void
        readonly levels: readonly import("@/agent").EffortLevel[]
        readonly budgetTokens: (level: import("@/agent").EffortLevel) => number | undefined
      }
    | undefined
  /** Ticket 14 (§11.6) — `/model` interactive picker wire. `current()` is the
   *  active sticky model for the CURRENT mode (or the boot model); `candidates()`
   *  are the selectable models each with their render metadata (window/output/
   *  recommended/hint — any field may be absent, the picker degrades); `set(id)`
   *  persists via the SAME sticky-model set path the loop reads (current mode is
   *  bound by the adapter, mode-implicit); `effortSupport(id)` resolves the
   *  picked model's reasoning-effort metadata so the command can clamp the
   *  session effort (Codex `validateEffort`). Absent ⇒ `/model` prints "not
   *  wired in this surface" (byte-identical). */
  readonly model?:
    | {
        readonly current: () => string
        readonly candidates: () => readonly import("./slash/model-picker").ModelLineMeta[]
        readonly set: (
          id: string,
        ) => Promise<
          | "ok"
          | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
          | { readonly kind: "write-error"; readonly message: string }
        >
        readonly effortSupport: (
          id: string,
        ) => import("@/llm/provider-metadata").ModelEffortSupport | undefined
      }
    | undefined
  /** C3 (jun-4-brief-mode RFC) — brief-mode session-posture wire. `get` returns
   *  the current brief state; `set` mutates the surface-owned brief store AND
   *  repaints any chrome (status pills). ORTHOGONAL to {@link effort} — both can
   *  be set. Absent ⇒ `/brief` prints "not wired in this surface" (parity with
   *  the rest of the surface-only commands). */
  readonly brief?:
    | {
        readonly get: () => boolean
        readonly set: (on: boolean) => void
      }
    | undefined
  /** ADR-0442 `/voice-live` composition-root wire. An async BUILDER that the
   *  surface populates only when the opt-in gate (`QUANTA_VOICE_LIVE`) is set:
   *  it constructs a live `RealtimeVoiceSessionPort` (Bun-WS transport +
   *  platform mic recorder + playback + injected clock/pump) plus a TTY-only
   *  raw-mode key reader, with the OpenAI bearer resolved at the composition
   *  root and threaded in as a value (the realtime slice never reads env/auth).
   *  Resolves `undefined` when the gate is off OR on a non-TTY host ⇒
   *  `/voice-live` declines cleanly (the realtime slice is never touched and
   *  the REPL is byte-identical). Absent slot ⇒ "not wired in this surface". */
  readonly voiceLive?: (() => Promise<VoiceLiveCtx | undefined>) | undefined
  /** ADR-0071 mid-turn typed control surface. `/cancel` + `/summarize-now`
   *  push typed actions the loop drains per-turn. Absent ⇒ those commands
   *  print "not wired in this surface". */
  readonly conversationActions?:
    | import("./repl/conversation-action-surface").ConversationActionSurface
    | undefined
  /** §steer — the session-mutable inbound delivery mode ref (queue|weave|
   *  interrupt). `/inbound` reads/sets `.current`; the session loop reads it per
   *  mid-turn line. Absent ⇒ `/inbound` prints "not wired". */
  readonly inboundMode?: { current: import("@/agent/inbound-mode").InboundMode } | undefined
  /** Ticket 17 `/agents` — live subagent fleet snapshot. A getter (read each
   *  invocation so `/agents` reflects the CURRENT registry, not a boot-time
   *  copy) returning the structural rows the renderer consumes. Absent ⇒
   *  `/agents` prints "not wired in this surface" + exit 0 (byte-identical to
   *  the rest of the presence-gated panels). The wire maps `TaskRecord`
   *  → {@link AgentFleetRow}; this slot never imports `@/subagent` VALUES. */
  readonly agents?: (() => readonly AgentFleetRow[]) | undefined
  /** Ticket 18 (V1) — READ-ONLY background-turn portal view. `/background`
   *  lists / reattaches (print-only) / cancels detached turns. Present iff
   *  `QUANTA_BG_TURN` is on AND the surface built a portal; absent ⇒
   *  `/background` prints "not wired" + exit 0 (default-OFF byte-identical).
   *  The view CANNOT detach a new turn nor re-enter the loop. */
  readonly background?: import("./repl/background-turn-portal").BackgroundPortalView | undefined
}

/** Inventory row returned by {@link SlashContext.skills}. Mirrors the host
 *  enforcement-relevant fields of a skill without importing `@/skill` types. */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly paths?: readonly string[]
}

export interface SlashCompletionHint {
  readonly value: string
  readonly kind: "command" | "argument" | "alias"
  readonly description?: string
}

export interface SlashCommand {
  readonly name: string
  readonly describe: string
  run(args: readonly string[], ctx: SlashContext): Promise<number>
  readonly category?:
    | "session"
    | "config"
    | "skills"
    | "auth"
    | "loop"
    | "help"
    | "history"
    | "alias"
    | "other"
  readonly complete?: (
    args: readonly string[],
    partial: string,
    ctx: SlashContext,
  ) => readonly SlashCompletionHint[]
  /**
   * ADR-0493 — thin-client dispatch route. Tells a thin host (web/ide) HOW to
   * run this command ("local" | "post-text" | "control-request"). Absent ⇒
   * "local". Resolved via `resolveThinClientRoute` under the
   * `QUANTA_THIN_CLIENT_DISPATCH` gate; additive/byte-identical when absent.
   */
  readonly thinClientDispatch?: ThinClientRoute
}

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
}

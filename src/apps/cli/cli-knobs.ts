/**
 * `apps/cli/cli-knobs.ts` — CLI-LOCAL knob registry (ADR-0503 P1, the 3rd knob
 * domain).
 *
 * The two existing knob registries are layer-bound:
 *   - `@/shared/runtime-config` — daemon VALUE config (consumed as `runtimeConfig().x`)
 *   - `@/runner/knobs`          — AgentConfig-MUTATING knobs (`apply(cfg)`)
 * Neither fits CLI-render knobs (status pills, flash timings, spinner, history …):
 * they touch NEITHER AgentConfig NOR daemon config — they only shape the local
 * terminal UI. Putting them in runtime-config would pollute the daemon struct;
 * putting them in @/runner/knobs would force a meaningless `apply(cfg)`.
 *
 * So this is a 3rd, deliberately-thin registry: pure DECLARATION metadata for
 * discoverability + governance. It does NOT change runtime behavior — each knob
 * is still READ at its existing call site (read-routing to this registry is a
 * later phase). Declaring it here makes it (a) non-orphan to the completeness
 * ratchet (ADR-0503), (b) surfaceable in `--help` / `/knobs` (W3).
 *
 * Slice note: declaration data. The seven seeded-gate overlaps are projected
 * from `cli-feature-gates.ts` so env keys are not copied. No env reads.
 */

import { CLI_SEEDED_SURFACE_KNOBS } from "./cli-feature-gates"

export type CliKnobKind = "bool" | "int" | "string" | "enum"

export interface CliKnob {
  /** The `QUANTA_*` env var name (SSOT key). */
  readonly envKey: `QUANTA_${string}`
  readonly kind: CliKnobKind
  /** Value when the env var is unset. For `bool`, `true` = default-ON (a
   *  kill-switch knob: `=0`/`=off` disables); `false` = opt-in. */
  readonly default: boolean | number | string | undefined
  /** One-line summary for `--help` / `/knobs` (W3). */
  readonly describe: string
  /** Grouping bucket for the config UI. */
  readonly group:
    | "status-ui"
    | "history"
    | "input"
    | "render"
    | "notify"
    | "session"
    | "voice"
    | "mcp"
    | "misc"
  /** Where the knob is actually read today (traceability; read-routing is P4). */
  readonly readSite: string
}

const overlapKnob = (gate: `QUANTA_${string}`): CliKnob => {
  const row = CLI_SEEDED_SURFACE_KNOBS.find((r) => r.gate === gate)
  if (row === undefined) {
    throw new Error(`CLI seeded surface knob missing: ${gate}`)
  }
  return {
    envKey: row.gate as `QUANTA_${string}`,
    kind: row.kind,
    default: row.default,
    group: row.group,
    describe: row.knobDescribe,
    readSite: row.readSite,
  }
}

/**
 * P1-C cluster 1 — status pills + flash timings (pure terminal UI). All
 * defaults verified against the read sites (status-flash-config.ts DEFAULTS,
 * status-pills.ts / lifecycle-pills.ts `parseEnvFlag(_, true)` / `isOff`).
 */
export const CLI_KNOBS: readonly CliKnob[] = [
  // ── flash / toast timings (status-flash-config.ts) — int ms / chars
  {
    envKey: "QUANTA_FLASH_ERROR_MS",
    kind: "int",
    default: 4000,
    group: "status-ui",
    describe: "Error toast linger (ms).",
    readSite: "status-flash-config.ts",
  },
  {
    envKey: "QUANTA_FLASH_IDLE_MS",
    kind: "int",
    default: 3000,
    group: "status-ui",
    describe: "Idle warning toast linger (ms).",
    readSite: "status-flash-config.ts",
  },
  {
    envKey: "QUANTA_FLASH_TRANSIENT_MS",
    kind: "int",
    default: 1500,
    group: "status-ui",
    describe: "Generic transient toast linger (ms).",
    readSite: "status-flash-config.ts",
  },
  {
    envKey: "QUANTA_ESC_WINDOW_MS",
    kind: "int",
    default: 2000,
    group: "input",
    describe: "Second-Esc gesture window (ms).",
    readSite: "status-flash-config.ts",
  },
  {
    envKey: "QUANTA_FLASH_TRUNCATE_CHARS",
    kind: "int",
    default: 120,
    group: "status-ui",
    describe: "Status-bar copy cap (chars).",
    readSite: "status-flash-config.ts",
  },

  // ── status pills (status-pills.ts) — bool, default-ON (=0 disables)
  {
    envKey: "QUANTA_PILLS",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Master switch for the status-bar pills (default ON on a TTY).",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_WORKSPACE",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Workspace pill.",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_MODE",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Mode + effort pills.",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_SKILLS",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Skills pill.",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_SANDBOX",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Sandbox pill.",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_RULES",
    kind: "bool",
    default: false,
    group: "status-ui",
    describe: "Rules pill (default OFF; =1 shows it).",
    readSite: "status-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_GOAL",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "`/goal` chip (default ON; renders only while a goal is active; =0 hides it).",
    readSite: "status-pills.ts",
  },

  // ── lifecycle pills (lifecycle-pills.ts) — bool, default-ON (=0 disables)
  {
    envKey: "QUANTA_LIFECYCLE_PILLS",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Master switch for lifecycle pills (default ON on a TTY).",
    readSite: "lifecycle-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_TASKS",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Tasks lifecycle pill.",
    readSite: "lifecycle-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_FOLLOWUP",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Follow-up lifecycle pill.",
    readSite: "lifecycle-pills.ts",
  },
  {
    envKey: "QUANTA_PILL_MCP",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "MCP lifecycle pill.",
    readSite: "lifecycle-pills.ts",
  },

  // ── P1-C cluster 2 — REPL render/input/history (cli-feature-config.ts).
  //    Defaults verified against the read site (isNotLiteralZero ⇒ default-ON;
  //    Number(?? "N") ⇒ int default N; gateOn ⇒ opt-in default false).
  {
    envKey: "QUANTA_HISTORY",
    kind: "bool",
    default: true,
    group: "history",
    describe: "Persistent REPL input history (=0 disables).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_HISTORY_MAX",
    kind: "int",
    default: 1000,
    group: "history",
    describe: "Max history entries retained.",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_HISTORY_FILE",
    kind: "string",
    default: "",
    group: "history",
    describe: "Override path for the history file.",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_MULTILINE",
    kind: "bool",
    default: true,
    group: "input",
    describe: "Multi-line REPL input editing (=0 disables).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_IMAGE_QUEUE",
    kind: "bool",
    default: true,
    group: "input",
    describe: "Paste-image queue in the REPL (=0 disables).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_IMAGE_MAX_QUEUE",
    kind: "int",
    default: 5,
    group: "input",
    describe: "Max queued paste-images.",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_SPINNER_INTERVAL_MS",
    kind: "int",
    default: 80,
    group: "render",
    describe: "Turn-indicator spinner frame interval (ms).",
    readSite: "repl/cli-feature-config.ts",
  },
  // The five session-surface settings below share the `env(key, default)` helper
  // with `QUANTA_MAX_TURNS` / `QUANTA_SPINNER_INTERVAL_MS` two lines apart in
  // `repl/session-runtime-config.ts`, and those two were declared. These were not
  // — the completeness ratchet's regex could not see `env("KEY", d)` because `env`
  // is a FUNCTION there, not a bag, so the omission never tripped anything. They
  // are ordinary operator settings, not internals: a permission posture, the idle
  // nudge, snooze, and the reject cap.
  {
    envKey: "QUANTA_PERMISSION",
    kind: "enum",
    default: "default",
    group: "session",
    describe:
      "Startup permission posture: default | acceptEdits | bypass | auto. `/posture` and `/mode` change it in-session.",
    readSite: "repl/session-runtime-config.ts",
  },
  {
    envKey: "QUANTA_IDLE_SUPPRESS",
    kind: "bool",
    default: true,
    group: "notify",
    describe:
      "Idle-presence tracking for the notify nudge. Default-ON ⇒ the nudge FIRES after QUANTA_IDLE_MS of inactivity; `=0` (the only accepted off-token) disables presence tracking, so the nudge never fires and QUANTA_IDLE_MS / QUANTA_SNOOZE_DEFAULT_MS are ignored.",
    readSite: "repl/session-runtime-config.ts",
  },
  {
    envKey: "QUANTA_IDLE_MS",
    kind: "int",
    default: 60000,
    group: "notify",
    describe: "Idle threshold before the nudge is considered (ms).",
    readSite: "repl/session-runtime-config.ts",
  },
  {
    envKey: "QUANTA_SNOOZE_DEFAULT_MS",
    kind: "int",
    default: 300000,
    group: "notify",
    describe: "Default snooze window applied when the operator defers a nudge (ms).",
    readSite: "repl/session-runtime-config.ts",
  },
  {
    envKey: "QUANTA_REJECT_LIMIT",
    kind: "int",
    default: 20,
    group: "session",
    describe: "Consecutive tool-approval rejections tolerated before the turn gives up.",
    readSite: "repl/session-runtime-config.ts",
  },
  // Shell-snapshot caps. Read through the local `intEnv("KEY")` helper, which is
  // why the regex scanner never saw them: the key is a call ARGUMENT, not a bag
  // property, and there is no `=`/`:` in front of the literal to anchor on.
  {
    envKey: "QUANTA_SHELL_SNAPSHOT_TIMEOUT",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Shell-snapshot capture timeout (ms). Unset ⇒ the built-in default. Requires QUANTA_SHELL_SNAPSHOT.",
    readSite: "internal/shell-snapshot.ts",
  },
  {
    envKey: "QUANTA_SHELL_SNAPSHOT_CLEANUP",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Age (ms) above which a stored shell snapshot is swept. Unset ⇒ 10 days. Requires QUANTA_SHELL_SNAPSHOT.",
    readSite: "internal/shell-snapshot.ts",
  },
  {
    envKey: "QUANTA_SHELL_SNAPSHOT_MAX_MB",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Total byte budget (MiB) for the shell-snapshot DIRECTORY — oldest snapshots are evicted first at session-start prune, NOT a per-file cap. Unset ⇒ 100 MiB. Requires QUANTA_SHELL_SNAPSHOT.",
    readSite: "internal/shell-snapshot.ts",
  },
  {
    envKey: "QUANTA_COMPACT_BREAKER_REACTIVE_MAX",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Cap on CONSECUTIVE reactive compactions before the breaker opens. Unset ⇒ 3. Requires QUANTA_COMPACT_BREAKER.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_COMPACT_BREAKER_PROACTIVE_MAX",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Cap on proactive compactions that shed too little to count as progress (< 15% of pre-compaction tokens) before the breaker opens — NOT a cap on attempts. Unset ⇒ 3. Requires QUANTA_COMPACT_BREAKER.",
    readSite: "internal.ts",
  },
  // Slash-registration gates. Both are default-ON opt-OUT and both were read as
  // `isOn(e.KEY, "1")` — the bag is named `e`, so `/\benv\./` could not match and
  // neither key was declared anywhere. `/knobs set` answered `unknown knob` for
  // them, which is the discoverability failure this registry exists to prevent.
  {
    envKey: "QUANTA_MEMORY_SLASH",
    kind: "bool",
    default: true,
    group: "session",
    describe: "Register the `/memory` command. Default-ON; `=0` removes the surface.",
    readSite: "memory-cmd.ts",
  },
  {
    envKey: "QUANTA_MEMORY_LIST_MAX",
    kind: "int",
    default: undefined,
    group: "session",
    describe:
      "Row cap for `/memory list`. Unset ⇒ 20 (which `/memory --help` already prints), and any value is clamped to a hard cap of 200.",
    readSite: "memory-cmd.ts",
  },
  {
    envKey: "QUANTA_DREAM_SLASH",
    kind: "bool",
    default: true,
    group: "session",
    describe: "Register the `/dream` command. Default-ON; `=0` removes the surface.",
    readSite: "dream-cmd.ts",
  },
  {
    envKey: "QUANTA_REWIND",
    kind: "bool",
    default: true,
    group: "session",
    describe: "Register the `/rewind` command. Default-ON; `=0` removes the surface.",
    readSite: "rewind-cmd.ts",
  },
  {
    envKey: "QUANTA_TIMELINE",
    kind: "int",
    default: 0,
    group: "render",
    describe: "Timeline panel height in rows (0 = off).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_METRICS",
    kind: "bool",
    default: false,
    group: "status-ui",
    describe: "Work-metrics stderr sink (opt-in).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_DECISION_METRICS",
    kind: "bool",
    default: false,
    group: "status-ui",
    describe: "Permission-decision metrics sink (opt-in).",
    readSite: "repl/cli-feature-config.ts",
  },

  // ── P1-C cluster 3 — CLI render/input/status/session/voice (defaults read
  //    from each call site; "(TTY)" = default-ON when stderr is a TTY).
  {
    envKey: "QUANTA_STATUSBAR",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Bottom status bar (default ON on a TTY).",
    readSite: "status-bar.ts",
  },
  {
    envKey: "QUANTA_SPINNER",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Turn-indicator spinner (TTY).",
    readSite: "turn-indicator.ts",
  },
  {
    envKey: "QUANTA_COST_PANEL",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Cost panel (TTY).",
    readSite: "cost-panel.ts",
  },
  {
    envKey: "QUANTA_TURN_SUMMARY",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Turn-end summary (TTY).",
    readSite: "turn-summary.ts",
  },
  {
    envKey: "QUANTA_TURN_SUMMARY_VERBOSE",
    kind: "bool",
    default: false,
    group: "status-ui",
    describe: "Verbose turn-summary format.",
    readSite: "turn-summary.ts",
  },
  {
    envKey: "QUANTA_BRANCH_SEARCH_PROGRESS",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Branch-search progress bar.",
    readSite: "branch-search-progress.ts",
  },
  {
    envKey: "QUANTA_DIFF_PREVIEW",
    kind: "bool",
    default: true,
    group: "render",
    describe: "Inline diff preview for edits (TTY).",
    readSite: "diff-preview.ts",
  },
  {
    envKey: "QUANTA_MD_HIGHLIGHT",
    kind: "bool",
    default: true,
    group: "render",
    describe:
      "Markdown syntax highlighting. STRICT: only the literal `=0` disables it (not off/false/no).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_MD_MODE",
    kind: "enum",
    default: "conservative",
    group: "render",
    describe: "Markdown rendering mode.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_ASK_USER",
    kind: "bool",
    default: false,
    group: "input",
    describe: "ask-user tool (TTY only, opt-in).",
    readSite: "ask-user-wire.ts",
  },
  overlapKnob("QUANTA_AT_AUTOCOMPLETE"),
  overlapKnob("QUANTA_EXTERNAL_EDITOR"),
  overlapKnob("QUANTA_KEYBINDINGS"),
  overlapKnob("QUANTA_MODE_CYCLE"),
  overlapKnob("QUANTA_PREFLIGHT_CHECK"),
  overlapKnob("QUANTA_BRACKETED_PASTE"),
  {
    envKey: "QUANTA_AUTOMATION_INBOX",
    kind: "bool",
    default: false,
    group: "notify",
    describe: "Automation inbox banner in REPL status (opt-in).",
    readSite: "repl/session-loop.ts",
  },
  {
    envKey: "QUANTA_HISTORY_DEFAULT_N",
    kind: "int",
    default: 20,
    group: "history",
    describe: "Default lines shown by /history.",
    readSite: "history-cmd.ts",
  },
  {
    envKey: "QUANTA_NOTIFY",
    kind: "enum",
    default: "off",
    group: "notify",
    describe: "Notification channel (off/bell/title).",
    readSite: "notify/notify-enabled.ts",
  },
  {
    envKey: "QUANTA_MCP_VERBOSE",
    kind: "bool",
    default: false,
    group: "mcp",
    describe: "Verbose MCP status output (opt-in).",
    readSite: "mcp-cmd.ts",
  },
  {
    envKey: "QUANTA_DEBUG",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Debug tracer category filter (opt-in).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_MIGRATE_CONFIG_IMPORT",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "Competitor-config import notice (opt-in).",
    readSite: "config-migration-notice.ts",
  },
  {
    envKey: "QUANTA_CHECKPOINT_CONV",
    kind: "bool",
    default: false,
    group: "session",
    describe: "Turn-end conversation checkpoint (opt-in).",
    readSite: "repl/surface-compose.ts",
  },
  {
    envKey: "QUANTA_PER_TOOL_RECORD",
    kind: "bool",
    default: false,
    group: "session",
    describe: "Per-tool snapshot recorder (opt-in).",
    readSite: "repl/surface-compose.ts",
  },
  {
    envKey: "QUANTA_PLAN_STORE",
    kind: "bool",
    default: true,
    group: "session",
    describe: "Plan store (default ON).",
    readSite: "repl/cli-feature-config.ts",
  },
  {
    envKey: "QUANTA_NDJSON_INGEST_FILE",
    kind: "string",
    default: "",
    group: "session",
    describe: "NDJSON ingest file path.",
    readSite: "repl/ndjson-wire.ts",
  },
  {
    envKey: "QUANTA_NDJSON_INGEST_PORT",
    kind: "int",
    default: 0,
    group: "session",
    describe: "NDJSON ingest HTTP port (0=off).",
    readSite: "repl/ndjson-wire.ts",
  },
  {
    envKey: "QUANTA_STATE_PATH",
    kind: "string",
    default: "",
    group: "session",
    describe: "State file path override.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_RESUME",
    kind: "string",
    default: "",
    group: "session",
    describe: "Resume session token/path.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_REPO_URL",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Git repo URL override (version line).",
    readSite: "repo-info.ts",
  },
  {
    envKey: "QUANTA_COMMIT",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Short commit hash override (version line).",
    readSite: "repo-info.ts",
  },
  // voice-live (CLI Realtime-API UX feature)
  {
    envKey: "QUANTA_VOICE_LIVE",
    kind: "bool",
    default: false,
    group: "voice",
    describe: "Realtime voice mode (opt-in).",
    readSite: "repl/voice-live-wire.ts",
  },
  {
    envKey: "QUANTA_VOICE_LIVE_ENDPOINT",
    kind: "string",
    default: "wss://api.openai.com/v1/realtime",
    group: "voice",
    describe: "Realtime WS endpoint.",
    readSite: "repl/voice-live-wire.ts",
  },
  {
    envKey: "QUANTA_VOICE_LIVE_MODEL",
    kind: "string",
    default: "gpt-realtime",
    group: "voice",
    describe: "Realtime API model.",
    readSite: "repl/voice-live-wire.ts",
  },
  {
    envKey: "QUANTA_VOICE_LIVE_VOICE",
    kind: "string",
    default: "",
    group: "voice",
    describe: "Realtime voice name.",
    readSite: "repl/voice-live-wire.ts",
  },

  // ── P1-C cluster 4 — CLI-surface gates that SEED agent features (read in
  //    apps/cli/internal.ts etc.; declared here because read here — eventual
  //    typed home may be runtime-config, P4 read-routing). Defaults verified.
  {
    envKey: "QUANTA_LSP",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "LSP diagnostics tools (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SKILLS",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "Skills framework (default ON).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SKILLS_DIR",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Custom skills directory path.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_PLAN",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "Plan mode (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_GIT_TOOLS",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "First-class git tools (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_GIT_CO_CHANGE",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "§7.2 git_co_change related-files tool (co-occurrence matrix; opt-in).",
    readSite: "internal.ts (gitToolList) + ci-bot.ts buildCiBotWiring (gitTools opts.coChange)",
  },
  {
    envKey: "QUANTA_FETCH_RULES",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "Fetch-rules tool gate (opt-in).",
    readSite: "fetch-rules-wire.ts",
  },
  {
    envKey: "QUANTA_VERIFY_GUARD",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "Block finish after unverified mutating tool (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_VERIFY_GUARD_MAX_TRIPS",
    kind: "int",
    default: undefined,
    group: "misc",
    describe: "Max verify-guard forced turns (unset ⇒ downstream default 2).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_KNOBS_PRESET",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Named knob preset to apply at boot.",
    readSite: "knobs-bootstrap.ts",
  },
  {
    envKey: "QUANTA_MODEL_FALLBACK",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Fallback model id list.",
    readSite: "internal.ts",
  },
  // ── TICKET-19 reverse-MCP server (quanta AS an MCP server). RCE surface, so
  //    QUANTA_MCP_SERVER is a STRICT gate (=== '1'); the EXPOSE list only widens
  //    the tools/list surface — every call still passes the permission gate.
  {
    envKey: "QUANTA_MCP_SERVER",
    kind: "bool",
    default: false,
    group: "mcp",
    describe:
      "Expose quanta AS an MCP server over stdio (strict =1; RCE surface, read-only by default).",
    readSite: "mcp-server-setup.ts",
  },
  {
    envKey: "QUANTA_MCP_SERVER_EXPOSE",
    kind: "string",
    default: "",
    group: "mcp",
    describe:
      "Comma list of extra tools the reverse-MCP server exposes (validated against the registry; each call is still permission-gated).",
    readSite: "mcp-server-setup.ts",
  },
  // T06 (jun-13 Codex-IDE reabsorption) — reverse-MCP LSP bridge. Co-homed with
  // its parent gates above (same composition root, mcp-server-setup.ts) so the
  // three reverse-MCP gates live in ONE registry and the web /knobs catalog
  // shows them consistently (all CLI-process-only). Exposes the EXISTING
  // read-only LSP tools (base `diagnostics` upgraded to the real provider + the
  // `lsp_*` nav family) — NOT a manifest tool gate; the tools are already
  // catalogued under QUANTA_LSP / QUANTA_LSP_TOOLS, this only governs reverse-MCP
  // exposure.
  {
    envKey: "QUANTA_LSP_MCP",
    kind: "bool",
    default: false,
    group: "mcp",
    describe: "Reverse-MCP server: expose read-only LSP tools (diagnostics/references/symbols).",
    readSite: "mcp-server-setup.ts",
  },
  {
    envKey: "QUANTA_COMPACT_BREAKER",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "Compaction breaker (default ON).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_COMPACT_MODEL",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Dedicated model for compaction.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_COMPACT_PROVIDER",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Provider override for compaction.",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_MEMORY_EMBED",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "Memory vector embedding (default ON).",
    readSite: "memory-compose.ts",
  },
  {
    envKey: "QUANTA_MEMORY_EMBED_MODEL",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Custom memory embedding model.",
    readSite: "memory-compose.ts",
  },
  overlapKnob("QUANTA_ENABLE_ENV_PROBE"),
  {
    envKey: "QUANTA_ENV_PROBE_TIMEOUT_MS",
    kind: "int",
    default: 5000,
    group: "session",
    describe: "Env-probe timeout (ms).",
    readSite: "repl/env-probe-wire.ts",
  },
  {
    envKey: "QUANTA_PLAYBOOK_TRIGGER",
    kind: "bool",
    default: false,
    group: "session",
    describe: "Playbook auto-trigger (opt-in).",
    readSite: "repl/playbook-trigger-wire.ts",
  },
  {
    envKey: "QUANTA_SHELL_SNAPSHOT",
    kind: "bool",
    default: false,
    group: "session",
    describe: "Shell environment capture (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SHELL_SNAPSHOT_SHELL",
    kind: "enum",
    default: "auto",
    group: "session",
    describe: "Shell for snapshot (auto/zsh/bash).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SHELL_SNAPSHOT_TURN",
    kind: "bool",
    default: true,
    group: "session",
    describe: "Snapshot per-turn (=0 = start-only).",
    readSite: "internal.ts",
  },

  // ── P1-C cluster 5 — subagent fan-out + remote + workflow (apps/cli reads).
  {
    envKey: "QUANTA_SUBAGENT_6TOOLS",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "6-tool background subagent router (default ON).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SUBAGENT_BATCH",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "spawn_batch fan-out tool (default ON).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SUBAGENT_INTROSPECT",
    kind: "bool",
    default: true,
    group: "misc",
    describe: "Subagent introspection tool (default ON).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SUBAGENT_MAX_CONCURRENT",
    kind: "int",
    default: undefined,
    group: "misc",
    describe: "Max concurrent subagents (unset/0 ⇒ host default).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SUBAGENT_MAX_DEPTH",
    kind: "int",
    default: undefined,
    group: "misc",
    describe: "Subagent recursion depth cap (unset/0 ⇒ host default).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_WORKFLOW",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "Declarative workflow tool (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_SPAWN_AGENTS_CSV",
    kind: "bool",
    default: false,
    group: "misc",
    describe: "spawn_agents_on_csv subagent tool gate (opt-in).",
    readSite: "internal.ts",
  },
  {
    envKey: "QUANTA_RETRY_MODELS",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Fallback model list for transient retry.",
    readSite: "repl/surface-compose.ts",
  },
  {
    envKey: "QUANTA_REMOTE_DEFAULT_IMAGE",
    kind: "string",
    default: "",
    group: "misc",
    describe: "Default Docker image for remote runner.",
    readSite: "index.ts",
  },
  {
    envKey: "QUANTA_REMOTE_TIMEOUT_MS",
    kind: "int",
    default: 0,
    group: "misc",
    describe: "Remote runner default timeout (ms).",
    readSite: "index.ts",
  },
  {
    envKey: "QUANTA_RULE_INDICATOR",
    kind: "bool",
    default: true,
    group: "status-ui",
    describe: "Active-rule indicator pill (default ON; =0 opts out).",
    readSite: "rule-indicator.ts",
  },
]

/** All CLI-local knob declarations (for `--help` / `/knobs` derivation + the
 *  completeness ratchet's 3rd registry). */
export const allCliKnobs = (): readonly CliKnob[] => CLI_KNOBS

/** Lookup by env key. */
export const cliKnob = (envKey: string): CliKnob | undefined =>
  CLI_KNOBS.find((k) => k.envKey === envKey)

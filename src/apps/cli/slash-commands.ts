/**
 * Five built-in slash commands (Tier-2 absorption #2-1, Claude Desktop 1.7196.3
 * built-in set: `/context`, `/usage`, `/color`, `/navigate`, `/wait`).
 *
 * Surface-agnostic dispatch: a future REPL or Tauri shell calls
 * `runSlashCommand(line, ctx)` with its own {@link SlashContext}. The CLI is
 * just the first surface — the table-driven BUILTINS list grows by APPENDING
 * entries to the registry, not by editing the dispatch switch.
 *
 * Slice discipline:
 *   - This file lives inside `src/apps/cli`. The five Tier-2 builtins import
 *     `node:*` only — surface-only commands MUST NOT invoke the LLM. The
 *     ADR-0065 `/retry-with` session command (appended to BUILTINS) is the
 *     deliberate exception: it needs the live transcript + an `LLMPort` from
 *     `@/llm` and is OPT-IN via `SlashContext.retry` (absent ⇒ no-op).
 *   - The CLI entry-point gate guarantees a slash command short-circuits
 *     BEFORE any agent loop / LLM construction code runs (surface commands);
 *     `/retry-with` runs in session context where the loop has already
 *     constructed its LLM stack.
 *
 * Preferences storage:
 *   - Path defaults to `<home>/.quanta/preferences.json` (where `<home>` is
 *     `QUANTA_PREFS_HOME` if set, else `os.homedir()`).
 *   - `ctx.prefsPath` overrides everything else (cleanest test seam).
 *   - Read is tolerant: missing file ⇒ empty object. Write performs
 *     `mkdir -p` on the parent.
 */

import { existsSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Plan } from "@/agent/plan/types"
import { runtimeConfig } from "@/shared"
import { formatBranchesPanel } from "./branch-search-progress"
import { type DebugCmdState, runDebugCmd } from "./debug-cmd"
import { editMessageCmd } from "./edit-message-cmd"
import { editPlanCmd } from "./edit-plan-cmd"
import { forkCheckpointCmd } from "./fork-checkpoint-cmd"
import { runHelpRender } from "./help-render"
// R10 panels (history exports its own cmd; the rest are defined below
// because their bodies live next to their renderers in the same slice).
import { historyCmd } from "./history-cmd"
import type { IdleMonitor } from "./idle-monitor"
import { parseSnoozeDuration } from "./idle-monitor"
import { loginCmd } from "./login-cmd"
import { logoutCmd } from "./logout-cmd"
import { mcpCmd } from "./mcp-cmd"
import { isMemorySlashEnabled, memoryCmd } from "./memory-cmd"
import { pasteCmd } from "./paste-cmd"
import { permissionCmd } from "./permission-explain"
import { PLAN_PANEL_NOT_WIRED, writePlanPanel } from "./plan-panel"
import { queueCmd } from "./queue-cmd"
import { type RetryWithSessionState, retryWithCmd } from "./retry-with"
import { isRewindEnabled, rewindCommands } from "./rewind-cmd"
import { rewindToolCmd } from "./rewind-tool-cmd"
import { rulesCmd } from "./rules-cmd"
import { type SideChatSessionState, sideCmd } from "./side-cmd"
import { snapshotCmd } from "./snapshot-cmd"
import { statusCmd } from "./status-cmd"
import { webCmd } from "./web-cmd"
import { renderWorkingStatePanel } from "./working-state-panel"

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
   *  registering the command). Injected by the SURFACE (a future REPL or
   *  session loop) — the 5 Tier-2 commands never read this field. */
  readonly retry?: RetryWithSessionState | undefined
  /** Cursor-inspired idle/snooze monitor. Wired by the REPL surface so
   *  `/snooze` and `/resume` mutate the SAME instance the REPL prompt
   *  source consults to refuse new turns. Absent ⇒ the two commands
   *  print "not wired in this surface" and exit 0 (default-OFF parity
   *  for one-shot / shell-entry surfaces). */
  readonly idle?: IdleMonitor | undefined
  /** Re-discover skills from disk on demand (Codex `forceReloadSkills` parity).
   *  Returns the freshly-discovered set as `{name, description, paths?}` so
   *  `/skills` and `/reload-skills` can render the inventory without coupling
   *  to `@/skill` types (slice isolation — slash-commands is `apps/cli`).
   *
   *  IMPORTANT — our loop already re-runs `discoverSkills` per turn (every
   *  `runAgent` calls `buildSessionFeatures` which calls `discoverSkills`),
   *  so the model-facing inventory auto-refreshes between user prompts. This
   *  callback exists for USER VISIBILITY: confirm a freshly-edited SKILL.md is
   *  picked up BEFORE submitting the next prompt. The callback is surface-only
   *  (no LLM call) so it is safe to register without a session. Absent ⇒ the
   *  commands print "skills surface not wired in this surface" and exit 0. */
  readonly skills?: (() => Promise<SkillRow[]>) | undefined
  /** Claude A9 `/side <q>` isolated agent loop. Wired by the REPL surface
   *  with the live session deps + assembler + (read-only) message reference.
   *  Absent ⇒ `/side` prints "not wired in this surface" and exits 0
   *  (default-OFF parity for one-shot / shell-entry surfaces). */
  readonly side?: SideChatSessionState | undefined
  /** R10 F (cost-panel) — sticky cumulative cost dashboard render seam. */
  readonly cost?: (() => string) | undefined
  /** R10 G (plan-panel) — read-only plan-store snapshot accessor. */
  readonly planSnapshot?: (() => import("@/agent/plan/types").Plan | null) | undefined
  /** R10 H (working-state-panel) — read-only WorkingState snapshot. */
  readonly workingState?: (() => import("@/agent").WorkingState | undefined) | undefined
  /** R10 I (history-cmd) — recent turns + tool-call breadcrumb. */
  readonly history?: import("./history-cmd").HistorySessionState | undefined
  /** R10 L (branch-search-progress) — N-best candidate tracker snapshot. */
  readonly branchSearch?: (() => import("./branch-search-progress").BranchProgressState) | undefined
  /** ADR-0236 / ADR-0213 — tool-profile slash wire. When set, `/profile`
   *  reads + writes the active profile through this seam. `get` returns the
   *  current profile name; `set` swaps it for the rest of the session
   *  (idempotent: setting the same name is a no-op). `list` enumerates the
   *  allowed profile names for the palette / tab-complete. Absent ⇒
   *  `/profile` prints "not wired in this surface" + exit 0. */
  readonly profile?:
    | {
        readonly get: () => string
        readonly set: (
          name: string,
        ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        readonly list: () => readonly string[]
      }
    | undefined
  /** ADR-0236 / ADR-0211 — identity-mode slash wire. When set, `/identity`
   *  reads + writes the active identity-mode through this seam. The surface
   *  owns the side-effect (e.g. rebuilding the cached system prompt /
   *  marking the next turn for re-prompt). Absent ⇒ "not wired" + exit 0. */
  readonly identity?:
    | {
        readonly get: () => string
        readonly set: (
          mode: string,
        ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        readonly list: () => readonly string[]
      }
    | undefined
  /** ADR-0236 / ADR-0219 — Focus Chain slash wire. When set, `/focus-chain`
   *  surfaces the tracker's current state and supports three sub-commands:
   *  `show` (default — print todos + drift warning), `reset` (clear all
   *  todos), `skip` (mark "no inject next turn" by ticking once). Absent
   *  ⇒ "not wired" + exit 0. */
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
  /** Track D — developer-mode debug tracer slash wire. When set, `/debug`
   *  reads + writes the runtime debug-tracer state through this seam. The
   *  surface owns the side effect (stream-tee swap-in). Absent ⇒ `/debug`
   *  prints a "not wired" line (with the QUANTA_DEBUG=1 hint) and exits 0
   *  — the runtime toggle requires the boot-time tee to have been
   *  allocated, so the slash is intentionally a no-op without it. */
  readonly debug?:
    | {
        readonly get: () => DebugCmdState
        readonly set: (state: DebugCmdState) => void
      }
    | undefined
}

/** Inventory row returned by {@link SlashContext.skills}. Mirrors the host
 *  enforcement-relevant fields of a skill without importing `@/skill` types
 *  (slice discipline). `paths` is preserved exactly so `/skills` can paint the
 *  conditional-activation glob list verbatim. */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly paths?: readonly string[]
}

/** Per-command argument completion candidate. Optional surface used by a
 *  readline-style completer; kept as an exported type so command authors
 *  can return strongly-typed hints from their `complete()` without reaching
 *  into another slice. */
export interface SlashCompletionHint {
  readonly value: string
  readonly kind: "command" | "argument" | "alias"
  readonly description?: string
}

export interface SlashCommand {
  readonly name: string
  readonly describe: string
  run(args: readonly string[], ctx: SlashContext): Promise<number>
  /** Optional palette category — UI surfaces (e.g. a future `/help`) can
   *  paint commands grouped by this label. Absent ⇒ "other" bucket. Closed
   *  literal union so a typo at the call site fails to compile. */
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
  /** Optional argument completer for `<Tab>`-driven readline completion.
   *  `args` = tokens BEFORE the cursor (excluding the partial); `partial`
   *  = the literal substring being typed. Absent ⇒ no suggestions after
   *  this command's name. */
  readonly complete?: (
    args: readonly string[],
    partial: string,
    ctx: SlashContext,
  ) => readonly SlashCompletionHint[]
}

const VALID_THEMES = ["auto", "light", "dark", "claude", "none"] as const
type Theme = (typeof VALID_THEMES)[number]
const THEME_SET: ReadonlySet<string> = new Set<string>(VALID_THEMES)
const isTheme = (s: string): s is Theme => THEME_SET.has(s)

interface Preferences {
  theme?: Theme
  preferredCwd?: string
}

const WAIT_MAX_SECONDS = 3600

const prefsHome = (ctx?: SlashContext): string =>
  ctx?.prefsHome ?? runtimeConfig().prefsHome ?? homedir()

const prefsFilePath = (ctx: SlashContext): string => {
  if (ctx.prefsPath !== undefined) return ctx.prefsPath
  return join(prefsHome(), ".quanta", "preferences.json")
}

const readPrefs = async (path: string): Promise<Preferences> => {
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return {}
    return parsed as Preferences
  } catch {
    return {}
  }
}

const writePrefs = async (path: string, prefs: Preferences): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8")
}

const contextCmd: SlashCommand = {
  name: "/context",
  describe: "Show current context-window usage",
  async run(_args, ctx) {
    const lastTokens = runtimeConfig().lastTokens
    ctx.out("context: not yet wired (Phase 1 placeholder)\n")
    ctx.out("Reports tokens-used / remaining once the loop exports per-turn usage.\n")
    if (lastTokens !== undefined && lastTokens !== "") {
      ctx.out(`last reported tokens: ${lastTokens}\n`)
    }
    return 0
  },
}

interface UsageLine {
  input_tokens?: unknown
  output_tokens?: unknown
}

const tallyUsage = (raw: string): { input: number; output: number; lines: number } => {
  let input = 0
  let output = 0
  let lines = 0
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const obj = JSON.parse(trimmed) as UsageLine
      if (typeof obj.input_tokens === "number") input += obj.input_tokens
      if (typeof obj.output_tokens === "number") output += obj.output_tokens
      lines += 1
    } catch {
      // best-effort tally — skip malformed
    }
  }
  return { input, output, lines }
}

const usageCmd: SlashCommand = {
  name: "/usage",
  describe: "Show aggregated lifetime + recent usage",
  async run(_args, ctx) {
    const path = join(prefsHome(ctx), ".quanta", "usage.jsonl")
    if (!existsSync(path)) {
      ctx.out("(no usage recorded yet)\n")
      return 0
    }
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (e) {
      ctx.err(`usage: failed to read ${path}: ${(e as Error).message}\n`)
      return 1
    }
    const { input, output, lines } = tallyUsage(raw)
    ctx.out(`usage (${lines} record${lines === 1 ? "" : "s"}):\n`)
    ctx.out(`  input_tokens:  ${input}\n`)
    ctx.out(`  output_tokens: ${output}\n`)
    ctx.out(`  total_tokens:  ${input + output}\n`)
    return 0
  },
}

const colorCmd: SlashCommand = {
  name: "/color",
  describe: "Get or set color theme (auto|light|dark|claude|none)",
  async run(args, ctx) {
    const path = prefsFilePath(ctx)
    const prefs = await readPrefs(path)
    if (args.length === 0) {
      ctx.out(`${prefs.theme ?? "auto"}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err("/color: expected at most one argument\n")
      return 1
    }
    const next = args[0]
    if (next === undefined || !isTheme(next)) {
      ctx.err(`/color: invalid theme: ${next} (valid: ${VALID_THEMES.join("|")})\n`)
      return 1
    }
    await writePrefs(path, { ...prefs, theme: next })
    ctx.out(`theme set to ${next}\n`)
    return 0
  },
}

const navigateCmd: SlashCommand = {
  name: "/navigate",
  describe: "Set preferred working directory (use '-' to unset)",
  async run(args, ctx) {
    if (args.length !== 1) {
      ctx.err("/navigate: expected exactly one argument (absolute path or '-')\n")
      return 1
    }
    const arg = args[0] as string
    const path = prefsFilePath(ctx)
    const prefs = await readPrefs(path)
    if (arg === "-") {
      const next: Preferences = { ...prefs }
      delete next.preferredCwd
      await writePrefs(path, next)
      ctx.out("preferredCwd cleared\n")
      return 0
    }
    try {
      await access(arg)
    } catch {
      ctx.err(`/navigate: path does not exist: ${arg}\n`)
      return 1
    }
    await writePrefs(path, { ...prefs, preferredCwd: arg })
    ctx.out(`${arg}\n`)
    return 0
  },
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const waitCmd: SlashCommand = {
  name: "/wait",
  describe: `Sleep N seconds then exit (cap ${WAIT_MAX_SECONDS}s)`,
  async run(args, ctx) {
    if (args.length !== 1) {
      ctx.err("/wait: expected exactly one argument (positive seconds)\n")
      return 1
    }
    const arg = args[0] as string
    const seconds = Number(arg)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      ctx.err(`/wait: invalid seconds: ${arg}\n`)
      return 1
    }
    if (seconds > WAIT_MAX_SECONDS) {
      ctx.err(`/wait: exceeds cap of ${WAIT_MAX_SECONDS}s\n`)
      return 1
    }
    const sleep = ctx.sleep ?? defaultSleep
    await sleep(seconds * 1000)
    return 0
  },
}

/** Grapheme-cluster-aware truncator. Walks {@link Intl.Segmenter}'s grapheme
 *  boundaries so an emoji / combining-mark / high-plane char near the limit is
 *  never split (naive `slice(0, max-3) + "..."` can yield half a surrogate pair
 *  or split a ZWJ sequence). Returns `s` verbatim if `s.length <= max`.
 *  Reserves 3 chars for the `...` suffix. */
const truncateGraphemes = (s: string, max: number): string => {
  if (s.length <= max) return s
  const limit = max - 3
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let acc = ""
  for (const { segment } of segmenter.segment(s)) {
    if (acc.length + segment.length > limit) break
    acc += segment
  }
  return `${acc}...`
}

/** Render an inventory row in the table-paddable form `/skills` and
 *  `/reload-skills` share. Truncates description to a one-line cap (100 chars
 *  incl. `...`) so REPL output stays scannable; the model still sees the full
 *  text via `buildSessionFeatures`. Multi-line ⇒ first line only (no body
 *  leak). Grapheme-aware truncation (no emoji / surrogate splitting). */
const renderSkillRow = (s: SkillRow): string => {
  const desc1 = s.description.split("\n")[0] ?? ""
  const desc = truncateGraphemes(desc1, 100)
  const pathsTag =
    s.paths && s.paths.length > 0
      ? ` [paths: ${s.paths.slice(0, 3).join(", ")}${s.paths.length > 3 ? "…" : ""}]`
      : ""
  return `  ${s.name.padEnd(24)} ${desc}${pathsTag}\n`
}

const renderSkills = (ctx: SlashContext, rows: readonly SkillRow[], prefix: string): void => {
  if (rows.length === 0) {
    ctx.out(`${prefix} (0 skills found)\n`)
    return
  }
  ctx.out(`${prefix} ${rows.length} skill${rows.length === 1 ? "" : "s"}:\n`)
  for (const r of rows) ctx.out(renderSkillRow(r))
}

/** Shared run-body for `/skills` and `/reload-skills`. Both commands take
 *  ZERO arguments (parity with Codex `forceReloadSkills`); extras error out
 *  for consistency with the rest of the BUILTINS (`/color foo bar` errors).
 *  Non-Error rejections from `ctx.skills()` are coerced via `String(e)` so the
 *  surfaced message never reads "undefined" (truly defensive, not just typed
 *  defensive). The two commands differ ONLY in the rendered prefix. */
const runSkillsRender = async (
  name: string,
  args: readonly string[],
  ctx: SlashContext,
  prefix: string,
): Promise<number> => {
  if (args.length > 0) {
    ctx.err(`${name}: takes no arguments; got ${args.length}\n`)
    return 1
  }
  if (ctx.skills === undefined) {
    ctx.out(`${name}: not wired in this surface\n`)
    return 0
  }
  try {
    const rows = await ctx.skills()
    renderSkills(ctx, rows, prefix)
    return 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.err(`${name}: discovery failed: ${msg}\n`)
    return 1
  }
}

const skillsCmd: SlashCommand = {
  name: "/skills",
  describe: "List discovered skills (name + description + paths)",
  run: (args, ctx) => runSkillsRender("/skills", args, ctx, "skills:"),
}

const reloadSkillsCmd: SlashCommand = {
  name: "/reload-skills",
  describe: "Re-discover skills from disk and print the result",
  run: (args, ctx) => runSkillsRender("/reload-skills", args, ctx, "reloaded:"),
}

/** `/snooze [duration]` — suspend new turn entry for `duration` (default 5m).
 *  Accepts `30s`, `5m`, `10m`, `1h`, or a bare millisecond integer; rejects
 *  zero / negative / unparseable tokens with exit 1. Absent monitor (one-shot
 *  surfaces) ⇒ prints "not wired" and exits 0 — symmetric with `/skills`. */
const snoozeCmd: SlashCommand = {
  name: "/snooze",
  describe: "Suspend new turns for a duration (default 5m). e.g. /snooze 10m",
  async run(args, ctx) {
    if (ctx.idle === undefined) {
      ctx.out("/snooze: not wired in this surface\n")
      return 0
    }
    if (args.length > 1) {
      ctx.err("/snooze: expected at most one argument (duration like 5m, 1h)\n")
      return 1
    }
    if (args.length === 0) {
      ctx.idle.snooze()
      ctx.out("snoozed (default duration). Use /resume to wake.\n")
      return 0
    }
    const arg = args[0] as string
    const ms = parseSnoozeDuration(arg)
    if (ms === null) {
      ctx.err(`/snooze: invalid duration: ${arg} (use 30s | 5m | 1h | bare ms)\n`)
      return 1
    }
    ctx.idle.snooze(ms)
    ctx.out(`snoozed for ${arg}. Use /resume to wake.\n`)
    return 0
  },
}

/** `/resume` — cancel an active snooze AND mark the REPL active (clear the
 *  idle clock). Idempotent — calling it when not snoozed is a no-op and
 *  prints a friendly message. */
const resumeCmd: SlashCommand = {
  name: "/resume",
  describe: "Cancel an active snooze and resume new turns",
  async run(args, ctx) {
    if (ctx.idle === undefined) {
      ctx.out("/resume: not wired in this surface\n")
      return 0
    }
    if (args.length > 0) {
      ctx.err("/resume: takes no arguments\n")
      return 1
    }
    const wasSnoozed = ctx.idle.isSnoozed()
    ctx.idle.unsnooze()
    ctx.idle.markActive()
    ctx.out(wasSnoozed ? "resumed.\n" : "(was not snoozed) ready.\n")
    return 0
  },
}

// R10 panel slash commands — bodies inline so the `BUILTINS` push at the
// bottom stays a single literal array (the registry contract). Each command
// returns exit 0 with "not wired in this surface" when its ctx field is
// absent (parity with /skills/snooze/side — default-OFF safety).

const costCmd: SlashCommand = {
  name: "/cost",
  describe: "Show cumulative session cost panel (tokens, duration, $)",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err("/cost: takes no arguments\n")
      return 1
    }
    if (ctx.cost === undefined) {
      ctx.out("/cost: not wired in this surface\n")
      return 0
    }
    const body = ctx.cost()
    if (body === "") {
      ctx.out("/cost: panel disabled (QUANTA_COST_PANEL=0 or non-TTY)\n")
      return 0
    }
    ctx.out(`${body}\n`)
    return 0
  },
}

const planCmd: SlashCommand = {
  name: "/plan",
  describe: "Show the current plan (current step + queue + completed)",
  category: "session",
  async run(args, ctx) {
    if (ctx.planSnapshot === undefined) {
      ctx.out(`${PLAN_PANEL_NOT_WIRED}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err("/plan: expected at most one argument (use `/plan` or `/plan show`)\n")
      return 1
    }
    const sub = args[0]
    if (sub !== undefined && sub !== "show") {
      ctx.err(`/plan: unknown subcommand: ${sub} (use \`/plan\` or \`/plan show\`)\n`)
      return 1
    }
    let plan: Plan | null
    try {
      plan = ctx.planSnapshot()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.err(`/plan: snapshot failed: ${msg}\n`)
      return 1
    }
    writePlanPanel(plan, ctx.out)
    return 0
  },
}

const stateCmd: SlashCommand = {
  name: "/state",
  describe: "Show current working state (posture, blockers, next steps, owners)",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err(`/state: takes no arguments; got ${args.length}\n`)
      return 1
    }
    if (ctx.workingState === undefined) {
      ctx.out("/state: not wired in this surface\n")
      return 0
    }
    const snap = ctx.workingState()
    ctx.out(`${renderWorkingStatePanel(snap)}\n`)
    return 0
  },
}

/** `/working-state` — long-form alias for `/state`. Same body so both names
 *  surface in `/help` (the renderer iterates BUILTINS verbatim). */
const workingStateCmd: SlashCommand = {
  name: "/working-state",
  describe: "Alias for /state",
  category: "session",
  run: stateCmd.run,
}

const branchesCmd: SlashCommand = {
  name: "/branches",
  describe: "Show last branch-search N-best leaderboard",
  category: "loop",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err("/branches: takes no arguments\n")
      return 1
    }
    if (ctx.branchSearch === undefined) {
      ctx.out("/branches: not wired in this surface\n")
      return 0
    }
    const state = ctx.branchSearch()
    ctx.out(`${formatBranchesPanel(state)}\n`)
    return 0
  },
}

/** `/help` — unified menu (slash inventory + keybinds + ENV knobs).
 *  Body lives in `./help-render` to keep this file small; the registry
 *  entry is a 1-liner delegating into `runHelpRender(BUILTINS, …)`. The
 *  `BUILTINS` reference is captured at call-time so `/help` always reflects
 *  the LIVE registry (and includes itself — the renderer iterates the
 *  passed-in array verbatim). */
const helpCmd: SlashCommand = {
  name: "/help",
  describe: "Show all slash commands, keybinds, and ENV knobs",
  category: "help",
  run: (args, ctx) => runHelpRender(BUILTINS, args, ctx),
}

/* ─────────────────────────────────────────────────────────────────────── */
/* ADR-0236 — composition-root mega-wire slash commands                     */
/* (`/profile`, `/identity`, `/focus-chain`).                               */
/*                                                                          */
/* Each is default-OFF: when `ctx.{profile|identity|focusChain}` is absent  */
/* the slash prints "not wired in this surface" and exits 0 (parity with    */
/* the rest of the surface-only commands). Surface owns the wire by         */
/* injecting a tiny adapter over the AgentConfig slot.                      */
/* ─────────────────────────────────────────────────────────────────────── */

const profileCmd: SlashCommand = {
  name: "/profile",
  describe: "Show or switch the active tool profile (ADR-0213)",
  category: "config",
  async run(args, ctx) {
    if (ctx.profile === undefined) {
      ctx.out("/profile: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const current = ctx.profile.get()
      const list = ctx.profile.list().join(", ")
      ctx.out(`/profile: current = ${current}\n`)
      ctx.out(`/profile: available = ${list}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/profile: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const name = args[0] as string
    const res = ctx.profile.set(name)
    if (res === "ok") {
      ctx.out(`/profile: set to '${name}'\n`)
      return 0
    }
    ctx.err(`/profile: unknown profile '${name}'; known = ${res.known.join(", ")}\n`)
    return 1
  },
}

const identityCmd: SlashCommand = {
  name: "/identity",
  describe: "Show or switch the active identity mode (ADR-0211)",
  category: "config",
  async run(args, ctx) {
    if (ctx.identity === undefined) {
      ctx.out("/identity: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const current = ctx.identity.get()
      const list = ctx.identity.list().join(", ")
      ctx.out(`/identity: current = ${current}\n`)
      ctx.out(`/identity: available = ${list}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/identity: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const mode = args[0] as string
    const res = ctx.identity.set(mode)
    if (res === "ok") {
      ctx.out(`/identity: set to '${mode}'\n`)
      return 0
    }
    ctx.err(`/identity: unknown mode '${mode}'; known = ${res.known.join(", ")}\n`)
    return 1
  },
}

const FOCUS_CHAIN_SUBCMDS = ["show", "reset", "skip"] as const
type FocusChainSubcmd = (typeof FOCUS_CHAIN_SUBCMDS)[number]
const isFocusChainSubcmd = (s: string): s is FocusChainSubcmd =>
  (FOCUS_CHAIN_SUBCMDS as readonly string[]).includes(s)

const focusChainCmd: SlashCommand = {
  name: "/focus-chain",
  describe: "Show / reset / skip the Focus Chain todo tracker (ADR-0219)",
  category: "config",
  async run(args, ctx) {
    if (ctx.focusChain === undefined) {
      ctx.out("/focus-chain: not wired in this surface\n")
      return 0
    }
    const sub: FocusChainSubcmd =
      args.length === 0
        ? "show"
        : isFocusChainSubcmd(args[0] as string)
          ? (args[0] as FocusChainSubcmd)
          : (() => {
              ctx.err(
                `/focus-chain: unknown subcommand '${args[0]}'; known = ${FOCUS_CHAIN_SUBCMDS.join(", ")}\n`,
              )
              return "show" as FocusChainSubcmd
            })()
    if (args.length > 0 && !isFocusChainSubcmd(args[0] as string)) {
      // The IIFE above already printed the error and degraded to `show`,
      // but we need to exit 1 for unknown subcommand.
      return 1
    }
    if (args.length > 1) {
      ctx.err(`/focus-chain: subcommands take no arguments; got ${args.length - 1} extra\n`)
      return 1
    }
    if (sub === "reset") {
      ctx.focusChain.reset()
      ctx.out("/focus-chain: cleared\n")
      return 0
    }
    if (sub === "skip") {
      ctx.focusChain.skip()
      ctx.out("/focus-chain: skipped one cycle\n")
      return 0
    }
    const snap = ctx.focusChain.snapshot()
    ctx.out(`/focus-chain: current turn = ${snap.currentTurn}\n`)
    if (snap.todos.length === 0) {
      ctx.out("/focus-chain: (no todos)\n")
    } else {
      ctx.out(`/focus-chain: ${snap.todos.length} todo(s):\n`)
      for (let i = 0; i < snap.todos.length; i++) {
        const t = snap.todos[i] as { readonly text: string; readonly state: string }
        ctx.out(`  ${i + 1}. [${t.state}] ${t.text}\n`)
      }
    }
    if (snap.driftWarning !== null) {
      ctx.out(`/focus-chain: drift — ${snap.driftWarning}\n`)
    }
    return 0
  },
}

/** Track D — `/debug` runtime toggle. Pure handler in `./debug-cmd`; the
 *  slash adapter delegates and applies the new state back through the
 *  `ctx.debug.set` seam. The handler never throws, so unknown arguments
 *  surface as a clean message (return 1) and the state stays prev. */
const debugCmd: SlashCommand = {
  name: "/debug",
  describe: "Toggle developer debug tracer (on | off | status | <categories>)",
  category: "config",
  async run(args, ctx) {
    if (ctx.debug === undefined) {
      ctx.out(
        "/debug: not wired in this surface (boot with QUANTA_DEBUG=1 to enable runtime toggle)\n",
      )
      return 0
    }
    const prev = ctx.debug.get()
    const result = runDebugCmd(args.join(" "), prev)
    // Unknown-argument case: handler returns `state === prev` and message
    // starts with the error prefix. Apply the unchanged state regardless
    // (idempotent) and surface the message to stderr + exit 1 for shell
    // chain-ability. Status / toggle / on / off / categories all share
    // the success path.
    if (result.message.startsWith("/debug: unknown argument")) {
      ctx.err(result.message)
      return 1
    }
    // `status` (and any future read-only sub-cmd) returns `state === prev`
    // by reference. Skip the set() to keep the side-effect strictly tied to
    // actual mutations — surfaces relying on a set-callback for instrumentation
    // (telemetry, render-bridge) don't see spurious no-op transitions.
    if (result.state !== prev) ctx.debug.set(result.state)
    ctx.out(result.message)
    return 0
  },
}

// `/rewind` + `/fork` (Claude Code v1.7196 pattern) are env-gated at module
// load: `QUANTA_REWIND=0` removes them from the registry entirely so they
// can't be discovered, auto-completed, or accidentally dispatched. Default
// `"1"` (registered).
const REWIND_COMMANDS: readonly SlashCommand[] = isRewindEnabled() ? rewindCommands : []

// `/memory` is env-gated the same way: `QUANTA_MEMORY_SLASH=0` removes it
// from the registry at load time. Default `"1"` (registered).
const MEMORY_COMMANDS: readonly SlashCommand[] = isMemorySlashEnabled() ? [memoryCmd] : []

export const BUILTINS: readonly SlashCommand[] = [
  helpCmd,
  contextCmd,
  usageCmd,
  colorCmd,
  navigateCmd,
  waitCmd,
  retryWithCmd,
  skillsCmd,
  reloadSkillsCmd,
  loginCmd,
  logoutCmd,
  statusCmd,
  permissionCmd,
  mcpCmd,
  snoozeCmd,
  resumeCmd,
  ...REWIND_COMMANDS,
  rewindToolCmd,
  sideCmd,
  snapshotCmd,
  rulesCmd,
  ...MEMORY_COMMANDS,
  // R10 panel commands — wired via `SlashContext.{cost,planSnapshot,workingState,history,branchSearch}`.
  costCmd,
  planCmd,
  stateCmd,
  workingStateCmd,
  historyCmd,
  branchesCmd,
  forkCheckpointCmd,
  // ADR-0221 — Queued follow-up per-msg manage (Codex composer parity).
  // Slot pinned by `slash-commands.test.ts` (immediately after
  // `/fork-checkpoint`, before the W2-5 web/paste/edit cluster). No
  // collision with `/rewind-tool`, `/fork`, or that cluster.
  queueCmd,
  // ADR-0224 — Aider `/web` + `/paste` (text-inbox attached to next turn).
  webCmd,
  pasteCmd,
  // ADR-0225 — Claude Code `tengu_external_editor` (mid-edit via $EDITOR).
  editPlanCmd,
  editMessageCmd,
  // ADR-0236 — composition-root mega-wire (`/profile`, `/identity`,
  // `/focus-chain`). Each is default-OFF: when the corresponding
  // SlashContext seat is absent the slash prints "not wired in this
  // surface" + exit 0. Slot pinned at the end so the W3-* parallel
  // tracks (slot-additive) do not collide with the appendage.
  profileCmd,
  identityCmd,
  focusChainCmd,
  // Track D — `/debug` runtime toggle. Default-OFF: when `ctx.debug` is
  // absent (boot-time tee not allocated) the slash prints a "not wired"
  // line + the QUANTA_DEBUG hint and exits 0 (parity with the rest of the
  // surface-only commands).
  debugCmd,
] as const

const BUILTINS_BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(
  BUILTINS.map((c) => [c.name, c]),
)

/** `/exit` and `/quit` are short-circuited by `composePromptPipeline` BEFORE the
 *  BUILTINS dispatch — they aren't `SlashCommand` entries but a user
 *  pressing <Tab> at the prompt expects them in the completion list. */
const REPL_VIRTUAL_COMMANDS = ["/exit", "/quit"] as const

/** Lookup the `describe` field for a slash command name. Returns
 *  `undefined` for unknown names (alias from a future plugin etc.). Used
 *  by the REPL prompt's command palette to paint the description column
 *  next to each candidate. */
export const describeSlashCommand = (name: string): string | undefined => {
  const cmd = BUILTINS_BY_NAME.get(name)
  return cmd?.describe
}

/** Node `readline` completer for the REPL prompt.
 *
 *  Behavior (matches Node's expected `(line) => [string[], string]` shape):
 *   - Empty / non-`/` input ⇒ no candidates (don't pollute the agent prompt).
 *   - `/` prefix ⇒ candidate list = builtin slash commands + the REPL-virtual
 *     `/exit`/`/quit` pair, filtered by `startsWith(line)`.
 *
 *  Tab on a single match completes the command; on multiple matches the
 *  reader paints the candidate list — both are stock readline behavior.
 *  The function is pure (no IO, no globals beyond the BUILTINS table) so the
 *  REPL can pass it straight to `readline.createInterface({ completer })`. */
export const slashCompleter = (line: string): [string[], string] => {
  if (line === "" || line[0] !== "/") return [[], line]
  const vocab = [...BUILTINS.map((c) => c.name), ...REPL_VIRTUAL_COMMANDS]
  const matches = vocab.filter((n) => n.startsWith(line)).sort()
  return [matches, line]
}

/** Recognise a CLI argv token as a slash-command invocation. `/foo` matches;
 *  `/path/to/file` does NOT (so legacy path-mode resume arguments fall through
 *  to the agent path). */
export const isSlashCommand = (s: string): boolean => {
  if (s.length < 2 || s[0] !== "/") return false
  const second = s[1]
  if (second === undefined) return false
  if (!/[a-z]/i.test(second)) return false
  // Reject embedded `/` so filesystem paths don't collide.
  return !s.slice(1).includes("/")
}

const tokenize = (line: string): readonly string[] =>
  line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)

/** Parse `line`, dispatch to the matching builtin, return its exit code. */
export const runSlashCommand = async (line: string, ctx: SlashContext): Promise<number> => {
  const tokens = tokenize(line)
  const name = tokens[0]
  if (name === undefined) {
    ctx.err("slash: empty command\n")
    return 1
  }
  const cmd = BUILTINS_BY_NAME.get(name)
  if (cmd === undefined) {
    ctx.err(`slash: unknown command: ${name}\n`)
    ctx.out("Available:\n")
    for (const c of BUILTINS) ctx.out(`  ${c.name.padEnd(12)} ${c.describe}\n`)
    return 1
  }
  return cmd.run(tokens.slice(1), ctx)
}

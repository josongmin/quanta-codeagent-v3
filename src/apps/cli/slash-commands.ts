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
import { runDebugCmd } from "./debug-cmd"
import { editMessageCmd } from "./edit-message-cmd"
import { editPlanCmd } from "./edit-plan-cmd"
import { forkCheckpointCmd } from "./fork-checkpoint-cmd"
import { runHelpRender } from "./help-render"
// R10 panels (history exports its own cmd; the rest are defined below
// because their bodies live next to their renderers in the same slice).
import { historyCmd } from "./history-cmd"
import { parseSnoozeDuration } from "./idle-monitor"
import { loginCmd } from "./login-cmd"
import { logoutCmd } from "./logout-cmd"
import { mcpCmd } from "./mcp-cmd"
import { isMemorySlashEnabled, memoryCmd } from "./memory-cmd"
import { pasteCmd } from "./paste-cmd"
import { permissionCmd } from "./permission-explain"
import { PLAN_PANEL_NOT_WIRED, writePlanPanel } from "./plan-panel"
import { queueCmd } from "./queue-cmd"
import { retryWithCmd } from "./retry-with"
import { isRewindEnabled, rewindCommands } from "./rewind-cmd"
import { rewindToolCmd } from "./rewind-tool-cmd"
import { rulesCmd } from "./rules-cmd"
import { sideCmd } from "./side-cmd"
import type { SkillRow, SlashCommand, SlashContext } from "./slash-contract"
import { createSlashRuntime, isSlashCommand } from "./slash-engine"
import { snapshotCmd } from "./snapshot-cmd"
import { statusCmd } from "./status-cmd"
import { webCmd } from "./web-cmd"
import { renderWorkingStatePanel } from "./working-state-panel"

export type { SkillRow, SlashCommand, SlashCompletionHint, SlashContext } from "./slash-contract"

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

/** `/exit` and `/quit` are short-circuited by `composePromptPipeline` BEFORE the
 *  BUILTINS dispatch — they aren't `SlashCommand` entries but a user
 *  pressing <Tab> at the prompt expects them in the completion list. */
const REPL_VIRTUAL_COMMANDS = ["/exit", "/quit"] as const

const slashRuntime = createSlashRuntime(BUILTINS, { virtualCommands: REPL_VIRTUAL_COMMANDS })

export const describeSlashCommand = slashRuntime.describe
export const slashCompleter = slashRuntime.complete
export const runSlashCommand = slashRuntime.run
export { isSlashCommand }

/**
 * CLI-03 — Surface-only slash-command registry (ADR-0306).
 *
 * This file owns slash commands whose entire blast radius is the CLI
 * surface: preferences, panels, skills inventory, env-knob diagnostics. They
 * do NOT need the live LLM, the agent loop, or the runner — and the slice
 * fence (biome `noRestrictedImports` against `@/agent`, `@/llm`, `@/runner`,
 * `@/host`) enforces it.
 *
 * Some commands here (`/snapshot`, `/queue`, `/fork-checkpoint`, `/cost`,
 * `/plan`, etc.) live in this layer even though their `*-cmd.ts` module
 * imports from `@/agent` / `@/storage` for types only — the cmd object
 * surface is purely a "read-only render via a ctx slot" body, and the
 * dispatch never invokes an LLM. The registry-level fence applies to direct
 * imports from `registry-surface.ts`, which is satisfied: each cmd is
 * brought in as an opaque `SlashCommand` object.
 *
 * Composition: `slash-commands.ts` concatenates
 * `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *   ...APP_SLASH_COMMANDS]` into the historic `BUILTINS`.
 */

import { existsSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errMessage, runtimeConfig } from "@/shared"
import { formatBranchesPanel } from "../branch-search-progress"
import { editMessageCmd } from "../edit-message-cmd"
import { editPlanCmd } from "../edit-plan-cmd"
import { forkCheckpointCmd } from "../fork-checkpoint-cmd"
import { runHelpRender } from "../help-render"
import { historyCmd } from "../history-cmd"
import { parseSnoozeDuration } from "../idle-monitor"
import { inspectCmd } from "../inspect-cmd"
import { loginCmd } from "../login-cmd"
import { logoutCmd } from "../logout-cmd"
import { pasteCmd } from "../paste-cmd"
import { PLAN_PANEL_NOT_WIRED, writePlanPanel } from "../plan-panel"
import { queueCmd } from "../queue-cmd"
import { replayCmd } from "../replay-cmd"
import { rulesCmd } from "../rules-cmd"
import { sessionCmd } from "../session-cmd"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { snapshotCmd } from "../snapshot-cmd"
import { statusCmd } from "../status-cmd"
import { formatSegmentedUsage } from "../status-line"
import { runVoiceLiveCmd } from "../voice-live-cmd"
import { webCmd } from "../web-cmd"
import { renderWorkingStatePanel } from "../working-state-panel"
import { runSkillsRender } from "./render-helpers"

const VALID_THEMES = ["auto", "light", "dark", "claude", "none"] as const
type Theme = (typeof VALID_THEMES)[number]
const THEME_SET: ReadonlySet<string> = new Set<string>(VALID_THEMES)
const isTheme = (s: string): s is Theme => THEME_SET.has(s)

interface Preferences {
  theme?: Theme
  preferredCwd?: string
}

const WAIT_MAX_SECONDS = 3600

const prefsHomeFromCtx = (ctx?: SlashContext): string =>
  ctx?.prefsHome ?? runtimeConfig().prefsHome ?? homedir()

const prefsFilePath = (ctx: SlashContext): string => {
  if (ctx.prefsPath !== undefined) return ctx.prefsPath
  return join(prefsHomeFromCtx(ctx), ".quanta", "preferences.json")
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
  describe: "Show segmented context-window usage (System/Rules/Conversation/…)",
  async run(_args, ctx) {
    // Track D: when the surface wires the `contextUsage` seam, render the
    // segmented per-category breakdown (Cursor UsageBar shape). The breakdown
    // is computed by the host from the latest assembled prompt using the
    // loop's OWN token estimator (no second heuristic here).
    const breakdown = ctx.contextUsage?.()
    if (breakdown !== undefined) {
      ctx.out(`${formatSegmentedUsage(breakdown)}\n`)
      return 0
    }
    // Fallback (seam absent / no prompt assembled yet): legacy placeholder line
    // + the env-reported last token count, byte-identical to the prior body.
    const lastTokens = runtimeConfig().lastTokens
    ctx.out("context: no prompt assembled yet (per-turn usage not available)\n")
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
    const path = join(prefsHomeFromCtx(ctx), ".quanta", "usage.jsonl")
    if (!existsSync(path)) {
      ctx.out("(no usage recorded yet)\n")
      return 0
    }
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (e) {
      ctx.err(`usage: failed to read ${path}: ${errMessage(e)}\n`)
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

// R10 panel slash commands — bodies inline so the layered registry is the
// single source of truth for surface-only slots. Each command returns exit 0
// with "not wired in this surface" when its ctx field is absent (parity with
// /skills/snooze/side — default-OFF safety).

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
    let plan: ReturnType<NonNullable<SlashContext["planSnapshot"]>>
    try {
      plan = ctx.planSnapshot()
    } catch (e) {
      const msg = errMessage(e)
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
 *  surface in `/help` (the renderer iterates the registry verbatim). */
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

/** `/voice-live` (ADR-0442) — live bidirectional spoken dialog. The surface
 *  populates `ctx.voiceLive` ONLY when the opt-in gate (`QUANTA_VOICE_LIVE`)
 *  is set AND the host is a TTY; that builder constructs the live
 *  `RealtimeVoiceSessionPort` (Bun-WS transport + platform mic recorder +
 *  playback + injected clock/pump) with the bearer resolved at the composition
 *  root and threaded in as a value. The slash itself never reaches into
 *  `@/realtime` / `@/voice` / `@/auth` — it only sees the constructed
 *  `VoiceLiveCtx`.
 *
 *  Default-OFF (byte-identical when the knob is unset):
 *    - slot absent ⇒ "realtime voice not wired in this surface" + exit 0,
 *    - builder resolves `undefined` (gate off / non-TTY) ⇒ same decline,
 *    - never auto-launches a live mic session without an interactive key
 *      reader (the cmd's own headless guard handles that). */
const voiceLiveCmd: SlashCommand = {
  name: "/voice-live",
  describe: "Live spoken dialog (mic up + transcript/audio down). Opt-in: QUANTA_VOICE_LIVE=1",
  category: "other",
  async run(_args, ctx) {
    if (ctx.voiceLive === undefined) {
      ctx.out("/voice-live: realtime voice not wired in this surface\n")
      return 0
    }
    let built: Awaited<ReturnType<NonNullable<SlashContext["voiceLive"]>>>
    try {
      built = await ctx.voiceLive()
    } catch (e) {
      ctx.err(`/voice-live: failed to construct session: ${errMessage(e)}\n`)
      return 1
    }
    if (built === undefined) {
      // Gate off (QUANTA_VOICE_LIVE unset) or non-TTY host ⇒ decline cleanly.
      ctx.out("/voice-live: realtime voice not enabled (set QUANTA_VOICE_LIVE=1 in a terminal)\n")
      return 0
    }
    // Reconstruct the full line so the cmd's own subcommand parser sees the
    // verb (`status` etc.). `_args` is the post-name token slice.
    const line = ["/voice-live", ..._args].join(" ")
    return runVoiceLiveCmd(line, built)
  },
}

/** `/help` — unified menu (slash inventory + keybinds + ENV knobs). The
 *  rendered list is whatever `SURFACE_SLASH_COMMANDS` is concatenated with at
 *  composition time — the assembly in `slash-commands.ts` passes the live
 *  full registry so `/help` reflects all three layers. */
const makeHelpCmd = (lookupBuiltins: () => readonly SlashCommand[]): SlashCommand => ({
  name: "/help",
  describe: "Show all slash commands, keybinds, and ENV knobs",
  category: "help",
  run: (args, ctx) => runHelpRender(lookupBuiltins(), args, ctx),
})

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

const stickyModelCmd: SlashCommand = {
  name: "/sticky-model",
  describe: "Show or set the per-mode sticky model (ADR-0462)",
  category: "config",
  async run(args, ctx) {
    if (ctx.stickyModel === undefined) {
      ctx.out("/sticky-model: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const snapshot = await ctx.stickyModel.list()
      const entries = Object.entries(snapshot)
      if (entries.length === 0) ctx.out("/sticky-model: no per-mode models set\n")
      else for (const [mode, modelId] of entries) ctx.out(`/sticky-model: ${mode} = ${modelId}\n`)
      ctx.out(`/sticky-model: modes = ${ctx.stickyModel.modes().join(", ")}\n`)
      ctx.out("/sticky-model: usage = /sticky-model <mode> <modelId>\n")
      return 0
    }
    if (args.length !== 2) {
      ctx.err(`/sticky-model: usage = /sticky-model <mode> <modelId> (got ${args.length} arg(s))\n`)
      return 1
    }
    const mode = args[0] as string
    const modelId = args[1] as string
    const res = await ctx.stickyModel.set(mode, modelId)
    if (res === "ok") {
      ctx.out(`/sticky-model: ${mode} → ${modelId}\n`)
      return 0
    }
    if (res.kind === "invalid-mode") {
      ctx.err(`/sticky-model: unknown mode '${mode}'; known = ${res.known.join(", ")}\n`)
      return 1
    }
    ctx.err(`/sticky-model: write failed — ${res.message}\n`)
    return 1
  },
  complete: (args, partial, ctx) => {
    if (ctx.stickyModel === undefined) return []
    const seed = partial.toLowerCase()
    // arg 0 = <mode>; arg 1 = <modelId>. `args` excludes the partial token, so
    // length 0 ⇒ completing the mode, length 1 ⇒ completing the modelId.
    if (args.length === 0) {
      return ctx.stickyModel
        .modes()
        .filter((m) => m.toLowerCase().startsWith(seed))
        .map((m) => ({ value: m, kind: "argument" as const }))
    }
    if (args.length === 1) {
      return ctx.stickyModel
        .candidates()
        .filter((id) => id.toLowerCase().startsWith(seed))
        .map((id) => ({ value: id, kind: "argument" as const }))
    }
    return []
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

/** `/effort` — session-level reasoning-effort picker. Codex `/model`-style UX
 *  but effort-only (model swap is `/retry-with`'s job). No args ⇒ status
 *  line + level list; one named arg ⇒ set the new tier (the wire callback
 *  mutates the surface-owned EffortStore AND repaints the chrome pill). The
 *  five tiers map to thinking budgets via `effortToTokenBudget` — `"default"`
 *  emits NO `thinking` field on LLMInput (provider default behavior). */
const formatEffortLine = (level: string, budget: number | undefined, current: boolean): string => {
  const marker = current ? "*" : " "
  const tag =
    budget === undefined
      ? "provider default (no thinking budget)"
      : `~${budget.toLocaleString("en-US")} tokens`
  return ` ${marker} ${level.padEnd(8)} ${tag}\n`
}

const effortCmd: SlashCommand = {
  name: "/effort",
  describe: "Show or switch session reasoning effort (default|low|medium|high|max)",
  category: "config",
  async run(args, ctx) {
    if (ctx.effort === undefined) {
      ctx.out("/effort: not wired in this surface\n")
      return 0
    }
    const { get, set, levels, budgetTokens } = ctx.effort
    if (args.length === 0) {
      const cur = get()
      const curBudget = budgetTokens(cur)
      ctx.out(
        `🧠 reasoning effort: ${cur}${curBudget !== undefined ? ` (~${curBudget.toLocaleString("en-US")} tokens)` : " (provider default)"}\n`,
      )
      for (const lvl of levels) ctx.out(formatEffortLine(lvl, budgetTokens(lvl), lvl === cur))
      ctx.out("use: /effort <level>\n")
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/effort: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const arg = (args[0] as string).trim().toLowerCase()
    const next = levels.find((l) => l === arg)
    if (next === undefined) {
      ctx.err(`/effort: unknown level '${arg}'; known = ${levels.join(", ")}\n`)
      return 1
    }
    set(next)
    const nextBudget = budgetTokens(next)
    ctx.out(
      nextBudget === undefined
        ? `🧠 effort: ${next} (provider default — no thinking budget)\n`
        : `🧠 effort: ${next} (~${nextBudget.toLocaleString("en-US")} tokens)\n`,
    )
    return 0
  },
  complete: (args, partial, ctx) => {
    if (ctx.effort === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    return ctx.effort.levels
      .filter((lvl) => lvl.startsWith(seed))
      .map((lvl) => ({ value: lvl, kind: "argument" as const }))
  },
}

/** Build the surface-layer registry. `helpRegistryLookup` is supplied by
 *  `slash-commands.ts` so `/help` reflects the LIVE concatenated registry
 *  (all three layers + any later spreads). The function form keeps the
 *  helpCmd capture lazy — there is no circular-import hazard because the
 *  closure runs only when a user types `/help`, long after module init.
 *
 *  The slot order matches the spec layered ordering: surface commands
 *  appear in the original BUILTINS order (minus the session/app cmds which
 *  hop layers), so `/help` continues to surface the same names. */
export const buildSurfaceSlashCommands = (
  helpRegistryLookup: () => readonly SlashCommand[],
): readonly SlashCommand[] => [
  makeHelpCmd(helpRegistryLookup),
  contextCmd,
  usageCmd,
  colorCmd,
  navigateCmd,
  waitCmd,
  skillsCmd,
  reloadSkillsCmd,
  loginCmd,
  logoutCmd,
  statusCmd,
  snoozeCmd,
  resumeCmd,
  snapshotCmd,
  rulesCmd,
  costCmd,
  planCmd,
  stateCmd,
  workingStateCmd,
  historyCmd,
  branchesCmd,
  forkCheckpointCmd,
  queueCmd,
  webCmd,
  voiceLiveCmd,
  pasteCmd,
  editPlanCmd,
  editMessageCmd,
  profileCmd,
  identityCmd,
  stickyModelCmd,
  focusChainCmd,
  effortCmd,
  inspectCmd,
  replayCmd,
  sessionCmd,
]

/** Static slot order — surface entries appended in the layered concatenation
 *  `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *    ...APP_SLASH_COMMANDS]`. `/help` is wired through the live builtins
 *  closure in {@link buildSurfaceSlashCommands}; the standalone form here is
 *  for tests that import the layer in isolation and want a stable shape.
 *  Tests of the FULL registry should use the assembled `BUILTINS` import. */
export const SURFACE_SLASH_COMMANDS: readonly SlashCommand[] = buildSurfaceSlashCommands(
  () => SURFACE_SLASH_COMMANDS,
)

/** `/help` unified menu — slash inventory + keybinds + ENV knobs.
 *
 *  Design contract:
 *   - **Slash inventory is DYNAMIC**: iterates the live `BUILTINS` array so a
 *     newly-appended command shows up here without editing this file. Virtual
 *     `/exit`+`/quit` (short-circuited by `runReplLoop` BEFORE BUILTINS
 *     dispatch) are appended as a fixed tail.
 *   - **Keybinds + ENV knobs are STATIC**: hand-curated literals in this
 *     file — they are surface-level conventions, not registry entries, so
 *     editing them requires this PR (no scattered allowlists).
 *   - **Color policy via `wrap` helpers in `@/ui/ui-helpers`**: `setColorPolicy
 *     ("off")` ⇒ plain ASCII byte-identical to a non-TTY render. Tests rely on
 *     this for the OFF-vs-ON pair.
 *   - **Slice discipline**: lives in `src/apps/cli`. Imports `@/ui/ui-helpers`
 *     (allowed) and `./slash-commands` (sibling). No agent / LLM imports.
 *
 *  Why a separate file (vs inline in slash-commands.ts):
 *   - slash-commands.ts is already 475 LOC; the unified menu is a self-
 *     contained renderer (~140 LOC including data tables) that benefits from
 *     isolated unit tests against a pure `renderHelp(BUILTINS)` entry point
 *     without spinning up the full slash dispatch.
 *   - `runHelpRender` (the SlashCommand callback) is a 4-line shim that
 *     delegates to `renderHelp`, keeping the registry entry trivial.
 */

import { bold, cyan, dim, renderBox } from "@/ui/ui-helpers"
import type { SlashCommand, SlashContext } from "./slash-commands"

/** Virtual REPL commands (short-circuited by `runReplLoop` BEFORE the
 *  BUILTINS dispatch — not `SlashCommand` entries, but a user pressing
 *  `/help` expects them in the listing). Kept in sync by hand with
 *  slash-commands.ts (single source of truth would be cross-slice churn). */
const VIRTUAL_COMMANDS: readonly { readonly name: string; readonly describe: string }[] = [
  { name: "/exit, /quit", describe: "Leave REPL" },
] as const

/** Static keybind table — these are conventions of the raw-line-reader, not
 *  registry entries. Update here when raw-line-reader.ts changes its
 *  bindings. */
const KEYBINDS: readonly { readonly key: string; readonly describe: string }[] = [
  { key: "Tab", describe: "Complete slash command" },
  { key: "↑ / ↓", describe: "History (when wired) / completion nav" },
  { key: "Ctrl+C", describe: "Abort current turn (Esc-Esc 2× = exit)" },
  { key: "Ctrl+D", describe: "EOF (exit on empty line)" },
] as const

/** Static ENV-knob table — surface-visible toggles, no proactive new knobs
 *  introduced here (those land in their own PR + ADR). */
const ENV_KNOBS: readonly { readonly key: string; readonly describe: string }[] = [
  { key: "QUANTA_MODEL=<id>", describe: "Override LLM model" },
  { key: "QUANTA_PROVIDER=<id>", describe: "anthropic/openai/chatgpt-oauth" },
  { key: "QUANTA_MAX_TURNS=<N>", describe: "Cap turns per run (default 40)" },
  { key: "QUANTA_PLAN=1", describe: "Plan-mode posture" },
  { key: "QUANTA_LSP=1", describe: "Enable LSP probe" },
  { key: "QUANTA_GIT_TOOLS=1", describe: "Expand git tool catalog" },
  { key: "QUANTA_METRICS=1", describe: "Per-turn work-metrics line" },
  { key: "QUANTA_VERIFY_GUARD=1", describe: "Closeout 4-rule reminder" },
  { key: "QUANTA_SKILLS=1", describe: "Bundled system skills" },
] as const

/** Column width for the slash-name column. Wide enough for `/reload-skills`
 *  plus 2 chars of breathing room — keeps describe columns aligned without
 *  measuring per call. */
const NAME_W = 18
const KEY_W = 22

const padVisible = (s: string, width: number): string => {
  // Names/keys we pass in here contain NO ANSI codes pre-color (we color
  // AFTER pad). Use plain `.length` — keeps this a pure string op.
  const pad = " ".repeat(Math.max(0, width - s.length))
  return s + pad
}

/** Render a single command/keybind/env row: `cyan-bold {name}  {describe}`.
 *  Color is applied via `wrap` helpers — `setColorPolicy("off")` makes this
 *  a no-op so the box content is plain ASCII. */
const renderRow = (name: string, describe: string, width: number): string => {
  const padded = padVisible(name, width)
  return `${bold(cyan(padded))}  ${describe}`
}

/** Pure render function — takes the BUILTINS table + virtual tail and emits
 *  the formatted box. Exported separately so tests can drive it without
 *  reaching through `runHelpRender`. */
export const renderHelp = (builtins: readonly SlashCommand[]): string => {
  const lines: string[] = []
  for (const c of builtins) {
    lines.push(renderRow(c.name, c.describe, NAME_W))
  }
  for (const v of VIRTUAL_COMMANDS) {
    lines.push(renderRow(v.name, v.describe, NAME_W))
  }
  lines.push("")
  lines.push(dim("── keybinds (raw-line-reader) ──"))
  for (const k of KEYBINDS) {
    lines.push(renderRow(k.key, k.describe, KEY_W))
  }
  lines.push("")
  lines.push(dim("── ENV knobs (common) ──"))
  for (const e of ENV_KNOBS) {
    lines.push(renderRow(e.key, e.describe, KEY_W))
  }
  return renderBox(lines, {
    title: "quanta — slash commands",
    titleStyle: bold,
    footer: "Docs: docs/runner/SURFACE_INTEGRATION.md",
  })
}

/** Render detail for a single slash command (`/help <name>`). The leading
 *  `/` is optional in the arg — `help skills` and `help /skills` both work.
 *  Unknown name ⇒ caller prints an error line. */
export const renderHelpDetail = (
  builtins: readonly SlashCommand[],
  rawArg: string,
): string | undefined => {
  const arg = rawArg.startsWith("/") ? rawArg : `/${rawArg}`
  const cmd = builtins.find((c) => c.name === arg)
  if (cmd === undefined) return undefined
  const lines: string[] = []
  lines.push(renderRow(cmd.name, "", NAME_W).trimEnd())
  lines.push("")
  lines.push(`${dim("describe:")} ${cmd.describe}`)
  if (cmd.category !== undefined) {
    lines.push(`${dim("category:")} ${cmd.category}`)
  }
  return renderBox(lines, { title: `help — ${cmd.name}`, titleStyle: bold })
}

/** SlashCommand callback. With ZERO args: render the unified menu. With ONE
 *  arg: render the per-command detail (or print "unknown" on miss). Extra
 *  args ⇒ error (consistent with the rest of BUILTINS — `/color foo bar`
 *  errors). */
export const runHelpRender = (
  builtins: readonly SlashCommand[],
  args: readonly string[],
  ctx: SlashContext,
): Promise<number> => {
  if (args.length === 0) {
    ctx.out(`${renderHelp(builtins)}\n`)
    return Promise.resolve(0)
  }
  if (args.length > 1) {
    ctx.err(`/help: expected at most one argument; got ${args.length}\n`)
    return Promise.resolve(1)
  }
  const arg = args[0] as string
  const detail = renderHelpDetail(builtins, arg)
  if (detail === undefined) {
    ctx.err(`/help: unknown command: ${arg}\n`)
    return Promise.resolve(1)
  }
  ctx.out(`${detail}\n`)
  return Promise.resolve(0)
}

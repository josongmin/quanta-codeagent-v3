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
import { runtimeConfig } from "@/shared"
import { loginCmd } from "./login-cmd"
import { logoutCmd } from "./logout-cmd"
import { type RetryWithSessionState, retryWithCmd } from "./retry-with"
import { statusCmd } from "./status-cmd"

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

export const BUILTINS: readonly SlashCommand[] = [
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
] as const

const BUILTINS_BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(
  BUILTINS.map((c) => [c.name, c]),
)

/** `/exit` and `/quit` are short-circuited by `runReplLoop` BEFORE the
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

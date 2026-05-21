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
import { type RetryWithSessionState, retryWithCmd } from "./retry-with"

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
  /** ADR-0065 model-swap retry session state. Absent ⇒ `/retry-with` prints
   *  "no model candidates configured" and is a no-op (byte-identical to NOT
   *  registering the command). Injected by the SURFACE (a future REPL or
   *  session loop) — the 5 Tier-2 commands never read this field. */
  readonly retry?: RetryWithSessionState | undefined
}

export interface SlashCommand {
  readonly name: string
  readonly describe: string
  run(args: readonly string[], ctx: SlashContext): Promise<number>
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

const prefsHome = (): string => runtimeConfig().prefsHome ?? homedir()

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
    const path = join(prefsHome(), ".quanta", "usage.jsonl")
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

export const BUILTINS: readonly SlashCommand[] = [
  contextCmd,
  usageCmd,
  colorCmd,
  navigateCmd,
  waitCmd,
  retryWithCmd,
] as const

const BUILTINS_BY_NAME: ReadonlyMap<string, SlashCommand> = new Map(
  BUILTINS.map((c) => [c.name, c]),
)

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

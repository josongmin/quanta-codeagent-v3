/**
 * Surface preferences cluster — `/context`, `/usage`, `/color`, `/navigate`,
 * `/wait` (extracted from `registry-surface.ts` to keep that module under the
 * god-module ceiling).
 *
 * These are the on-disk-preferences + token-usage + sleep commands. They own
 * their private helpers (the theme vocabulary, the `.quanta/preferences.json`
 * read/write pair, the usage.jsonl tally, the default sleep). None of the
 * consts are part of the surface public API — the assembler in
 * `registry-surface.ts` imports them by name into `buildSurfaceSlashCommands`.
 * Pure code motion: bodies are byte-identical to the pre-split file.
 */

import { existsSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errMessage, runtimeConfig } from "@/shared"
import type { SlashCommand, SlashContext } from "../../slash-contract"
import { formatSegmentedUsage } from "../../status-line"

const VALID_THEMES = [
  "auto",
  "light",
  "dark",
  "claude",
  "none",
  "light-daltonized",
  "dark-daltonized",
] as const
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

export const contextCmd: SlashCommand = {
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

export const usageCmd: SlashCommand = {
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

export const colorCmd: SlashCommand = {
  name: "/color",
  describe: "Get or set color theme (auto|light|dark|claude|none|light-daltonized|dark-daltonized)",
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

export const navigateCmd: SlashCommand = {
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

export const waitCmd: SlashCommand = {
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

/**
 * `/knobs` slash command family — CLI surface adapter over the `@/runner/knobs`
 * framework (SOTA++ knob registry).
 *
 * Subcommands:
 *   - `/knobs show`            (default) compact box of currently active knobs
 *   - `/knobs list`            full inventory (all 12 registered) + active marks
 *   - `/knobs set <id>=<val>`  session-level override (mutates the bootstrap's
 *                              sessionOverrides bag — re-resolved on next read)
 *   - `/knobs reset <id>`      remove a session override
 *   - `/knobs preset <name>`   apply a named preset bundle as session overrides
 *   - `/knobs save`            persist sessionOverrides → `~/.quanta/knobs.json`
 *   - `/knobs help [id]`       family summary OR per-knob long help
 *
 * Wire contract: the caller passes a {@link KnobsSurfaceWire} captured by
 * closure (mirror of how `makeHelpCmd` captures its registry lookup). This
 * keeps the slash command free of any `SlashContext` widening — there is no
 * `ctx.knobs` slot. The wire owns:
 *   - the live registry (read via `knobsForSurface(surface)`)
 *   - the sessionOverrides bag (mutated by `setOverride` / `resetOverride`)
 *   - the resolved-values snapshot accessor
 *
 * Error UX:
 *   - unknown subcommand ⇒ stderr + exit 1
 *   - unknown knob id ⇒ stderr + exit 1 (graceful, not a throw)
 *   - non-hot-toggleable knob ⇒ warning written to stdout AND override
 *     accepted (the value still lands in sessionOverrides so `/knobs save`
 *     captures it for next-session pickup)
 *   - parse failure (knob's parse threw on the raw) ⇒ caught by the framework
 *     as `KnobParseError` AND re-thrown — surfaced as stderr + exit 1
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  type AnyKnob,
  allKnobs,
  KNOB_PRESETS,
  type KnobValueMap,
  knobsForSurface,
  resolveKnobs,
  writeKnobConfig,
} from "@/runner/knobs"
import { errMessage } from "@/shared"
import type { SlashCommand, SlashContext } from "./slash-commands"

/** Surface-wire contract passed to {@link buildKnobsSlash}. */
export interface KnobsSurfaceWire {
  /** Resolve current knob values (read-only snapshot, CLI-surface filtered). */
  readonly resolution: () => KnobValueMap
  /** Set a session-level override. Returns a warning string if the knob is
   *  NOT hot-toggleable (the value is still applied to sessionOverrides so
   *  `/knobs save` can persist it for next-session pickup). Returns
   *  `undefined` on a clean set. Throws a `KnobParseError` if the value
   *  cannot be parsed (caller surfaces as stderr). */
  readonly setOverride: (id: string, raw: string) => string | undefined
  /** Remove a session override — no-op if the knob wasn't set. */
  readonly resetOverride: (id: string) => void
  /** Snapshot of the current session-overrides map (for `/knobs save`). */
  readonly sessionOverrides: () => Record<string, string>
  /** Persist sessionOverrides → `~/.quanta/knobs.json`. */
  readonly save: () => Promise<void>
  /** Final config-file path that would be written — surfaced by `/knobs
   *  save` so the user knows where the file lives. */
  readonly configPath: string
}

const SUBCOMMANDS = ["show", "list", "set", "reset", "preset", "save", "help"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
const isSubcommand = (s: string): s is Subcommand => (SUBCOMMANDS as readonly string[]).includes(s)

type Hint = { readonly value: string; readonly kind: "argument" }
const hintsFrom = (xs: readonly string[], seed: string): readonly Hint[] =>
  xs.filter((x) => x.startsWith(seed)).map((value) => ({ value, kind: "argument" as const }))

/** Completion adapter — extracted so the slash record body stays under the
 *  cognitive-complexity ceiling. Returns hints for:
 *    - `/knobs <subcommand>`         (first slot)
 *    - `/knobs reset|help <id>`      (knob id slot)
 *    - `/knobs preset <name>`        (preset name slot)
 *  All other positions return []. */
const completeKnobs = (args: readonly string[], partial: string): readonly Hint[] => {
  if (args.length === 0) return hintsFrom(SUBCOMMANDS as readonly string[], partial)
  if (args.length !== 1) return []
  const sub = args[0]
  if (sub === "reset" || sub === "help") {
    return hintsFrom([...allKnobs().keys()], partial)
  }
  if (sub === "preset") {
    return hintsFrom(Object.keys(KNOB_PRESETS), partial)
  }
  return []
}

/** Build the `/knobs` slash command, closed-over the wire. */
export const buildKnobsSlash = (wire: KnobsSurfaceWire): SlashCommand => ({
  name: "/knobs",
  category: "config",
  describe: "Show / set / save knob settings (run /knobs help for details)",
  complete: completeKnobs,
  async run(args, ctx) {
    const sub = args[0] ?? "show"
    if (!isSubcommand(sub)) {
      ctx.err(`/knobs: unknown subcommand: ${sub} (use one of ${SUBCOMMANDS.join(", ")})\n`)
      return 1
    }
    switch (sub) {
      case "show":
        return renderActive(wire, ctx)
      case "list":
        return renderList(wire, ctx)
      case "set":
        return doSet(args.slice(1), wire, ctx)
      case "reset":
        return doReset(args.slice(1), wire, ctx)
      case "preset":
        return doPreset(args.slice(1), wire, ctx)
      case "save":
        return doSave(args.slice(1), wire, ctx)
      case "help":
        return doHelp(args.slice(1), ctx)
    }
  },
})

/* ─── rendering helpers ─────────────────────────────────────────────── */

/** Single-side fixed-width box. The body lines are right-padded then a final
 *  `│` is appended; the top/bottom rails use the same `width` so a long body
 *  line never visibly overflows when stderr is wider than 60 cols. */
const W = 60
const bot = `╰${"─".repeat(W - 2)}╯`
const titleBar = (label: string): string => {
  // ╭─ <label> ─────────╮
  const left = `╭─ ${label} `
  const fill = "─".repeat(Math.max(0, W - 1 - left.length))
  return `${left}${fill}╮`
}
const padLine = (body: string): string => {
  // Body interior width = W - 4 ("│ " + body + " │")
  const inner = W - 4
  const visible = body.length > inner ? body.slice(0, inner) : body
  const pad = " ".repeat(Math.max(0, inner - visible.length))
  return `│ ${visible}${pad} │`
}

const surfaceTag = (knob: AnyKnob): string => {
  // Only mark non-CLI surfaces — a CLI knob needs no tag in CLI output.
  if (knob.surfaces.includes("cli")) return ""
  // Surface bag: `["bench"]` ⇒ "bench-only"; multi-surface ⇒ comma-joined.
  if (knob.surfaces.length === 1 && knob.surfaces[0] !== undefined) {
    return `${knob.surfaces[0]}-only`
  }
  return knob.surfaces.join(",")
}

const fmtValue = (v: unknown): string => {
  if (v === true) return "on"
  if (v === false) return "off"
  if (v === undefined || v === null) return "-"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/* ─── /knobs show ───────────────────────────────────────────────────── */

const renderActive = (wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  const values = wire.resolution()
  const all = allKnobs()
  const cliKnobs = countCliKnobs(all)
  ctx.out(`${titleBar("Active knobs")}\n`)
  if (values.size === 0) {
    ctx.out(padLine("(none active — run /knobs list to see all)"))
    ctx.out("\n")
  } else {
    for (const [id, kv] of values) {
      ctx.out(padLine(`${id.padEnd(16)} = ${fmtValue(kv.value).padEnd(12)} (source: ${kv.source})`))
      ctx.out("\n")
    }
    ctx.out(padLine(`${values.size} active | ${cliKnobs} available (run /knobs list)`))
    ctx.out("\n")
  }
  ctx.out(`${bot}\n`)
  return 0
}

/* ─── /knobs list ───────────────────────────────────────────────────── */

const renderList = (wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  const values = wire.resolution()
  const all = allKnobs()
  const total = all.size
  const activeCount = values.size
  ctx.out(`${titleBar(`Knobs (${total} registered, ${activeCount} active)`)}\n`)
  for (const [id, knob] of all) {
    const kv = values.get(id)
    const mark = kv !== undefined ? "✓" : " "
    const cat = `[${knob.category}]`
    const val = kv !== undefined ? fmtValue(kv.value) : "-"
    const src = kv !== undefined ? `(${kv.source})` : ""
    const tag = surfaceTag(knob)
    const tagBit = tag !== "" ? `  ${tag}` : ""
    ctx.out(padLine(`${mark} ${id.padEnd(18)} ${cat.padEnd(9)} ${val.padEnd(12)} ${src}${tagBit}`))
    ctx.out("\n")
  }
  ctx.out(`${bot}\n`)
  return 0
}

const countCliKnobs = (all: ReadonlyMap<string, AnyKnob>): number => {
  let n = 0
  for (const k of all.values()) if (k.surfaces.includes("cli")) n++
  return n
}

/* ─── /knobs set <id>=<val> ─────────────────────────────────────────── */

const doSet = (args: readonly string[], wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  if (args.length !== 1) {
    ctx.err("/knobs set: expected exactly one argument of form `<id>=<val>`\n")
    return 1
  }
  const pair = args[0] as string
  const eq = pair.indexOf("=")
  if (eq <= 0) {
    ctx.err(`/knobs set: invalid argument: ${pair} (expected \`<id>=<val>\`)\n`)
    return 1
  }
  const id = pair.slice(0, eq)
  const raw = pair.slice(eq + 1)
  const knob = allKnobs().get(id)
  if (knob === undefined) {
    ctx.err(`/knobs set: unknown knob: ${id}\n`)
    return 1
  }
  let warning: string | undefined
  try {
    warning = wire.setOverride(id, raw)
  } catch (e) {
    ctx.err(`/knobs set: ${errMessage(e)}\n`)
    return 1
  }
  ctx.out(`/knobs: ${id} = ${raw} (session override)\n`)
  if (warning !== undefined) {
    ctx.out(`  warning: ${warning}\n`)
  }
  return 0
}

/* ─── /knobs reset <id> ─────────────────────────────────────────────── */

const doReset = (args: readonly string[], wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  if (args.length !== 1) {
    ctx.err("/knobs reset: expected exactly one argument (knob id)\n")
    return 1
  }
  const id = args[0] as string
  if (allKnobs().get(id) === undefined) {
    ctx.err(`/knobs reset: unknown knob: ${id}\n`)
    return 1
  }
  const overrides = wire.sessionOverrides()
  if (!Object.hasOwn(overrides, id)) {
    ctx.out(`/knobs: ${id} had no session override (no-op)\n`)
    return 0
  }
  wire.resetOverride(id)
  ctx.out(`/knobs: ${id} session override cleared\n`)
  return 0
}

/* ─── /knobs preset <name> ──────────────────────────────────────────── */

const doPreset = (args: readonly string[], wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  if (args.length !== 1) {
    ctx.err(
      `/knobs preset: expected exactly one argument (known: ${Object.keys(KNOB_PRESETS).join(", ")})\n`,
    )
    return 1
  }
  const name = args[0] as string
  const preset = KNOB_PRESETS[name]
  if (preset === undefined) {
    ctx.err(
      `/knobs preset: unknown preset: ${name} (known: ${Object.keys(KNOB_PRESETS).join(", ")})\n`,
    )
    return 1
  }
  const applied: string[] = []
  const skipped: string[] = []
  for (const [id, raw] of Object.entries(preset)) {
    if (allKnobs().get(id) === undefined) {
      skipped.push(id)
      continue
    }
    try {
      wire.setOverride(id, raw)
      applied.push(`${id}=${raw}`)
    } catch {
      skipped.push(`${id} (parse failed for "${raw}")`)
    }
  }
  if (applied.length === 0 && skipped.length === 0) {
    ctx.out(`/knobs preset: ${name} is empty (no knobs to apply)\n`)
    return 0
  }
  if (applied.length > 0) {
    ctx.out(`/knobs preset: applied ${applied.length} knob(s): ${applied.join(", ")}\n`)
  }
  if (skipped.length > 0) {
    ctx.out(`/knobs preset: skipped: ${skipped.join(", ")}\n`)
  }
  return 0
}

/* ─── /knobs save ───────────────────────────────────────────────────── */

const doSave = async (
  args: readonly string[],
  wire: KnobsSurfaceWire,
  ctx: SlashContext,
): Promise<number> => {
  if (args.length > 0) {
    ctx.err("/knobs save: takes no arguments\n")
    return 1
  }
  const overrides = wire.sessionOverrides()
  const count = Object.keys(overrides).length
  try {
    await wire.save()
  } catch (e) {
    ctx.err(`/knobs save: ${errMessage(e)}\n`)
    return 1
  }
  ctx.out(`/knobs: saved ${count} override(s) → ${wire.configPath}\n`)
  return 0
}

/* ─── /knobs help ───────────────────────────────────────────────────── */

const FAMILY_HELP = [
  "/knobs                  — alias for `/knobs show`",
  "/knobs show             — render active knobs (compact box)",
  "/knobs list             — render full registry + active marks",
  "/knobs set <id>=<val>   — set a session-level override",
  "/knobs reset <id>       — clear a session override",
  `/knobs preset <name>    — apply a named bundle (known: ${Object.keys(KNOB_PRESETS).join(", ")})`,
  "/knobs save             — persist session overrides to ~/.quanta/knobs.json",
  "/knobs help [id]        — this menu, OR long help for one knob",
].join("\n")

const doHelp = (args: readonly string[], ctx: SlashContext): number => {
  if (args.length === 0) {
    ctx.out(`${FAMILY_HELP}\n`)
    return 0
  }
  if (args.length > 1) {
    ctx.err("/knobs help: expected at most one argument (knob id)\n")
    return 1
  }
  const id = args[0] as string
  const knob = allKnobs().get(id)
  if (knob === undefined) {
    ctx.err(`/knobs help: unknown knob: ${id}\n`)
    return 1
  }
  ctx.out(`${knob.id} — ${knob.describe}\n`)
  ctx.out(`  category : ${knob.category}\n`)
  ctx.out(`  envKey   : ${knob.envKey}\n`)
  ctx.out(`  surfaces : ${knob.surfaces.join(", ")}\n`)
  if (knob.source !== undefined) ctx.out(`  source   : ${knob.source}\n`)
  if (knob.help !== undefined) ctx.out(`\n${knob.help}\n`)
  return 0
}

/* ─── BUILTINS registration — default wire ──────────────────────────── */

/** Default wire used by the BUILTINS-registered `/knobs` command. Backed by
 *  a module-level session-overrides bag so successive `/knobs set`/`/knobs
 *  reset`/`/knobs save` invocations in the SAME process see consistent
 *  state. Surfaces that need their own scoped wire (a multi-session host,
 *  for instance) should call {@link buildKnobsSlash} directly with a fresh
 *  wire and bypass this default registration.
 *
 *  This mirrors the `loginCmd = buildLoginCmd()` pattern: a default-deps
 *  static instance suitable for the standard single-session REPL. */
const DEFAULT_OVERRIDES: Record<string, string> = {}

const defaultConfigPath = (): string => join(homedir(), ".quanta", "knobs.json")

const defaultResolve = (): KnobValueMap =>
  resolveKnobs({
    surface: "cli",
    knobs: knobsForSurface("cli"),
    sessionOverrides: DEFAULT_OVERRIDES,
    envVars: process.env,
  })

const defaultWire: KnobsSurfaceWire = {
  resolution: defaultResolve,
  setOverride: (id, raw) => {
    const knob = allKnobs().get(id)
    DEFAULT_OVERRIDES[id] = raw
    // Surface a non-fatal warning when the knob is read once at boot and
    // cannot take effect mid-session — the override is still saved for the
    // next process via `/knobs save`.
    if (knob !== undefined && knob.hotToggleable === false) {
      return `knob '${id}' is not hot-toggleable — saved for next session`
    }
    return undefined
  },
  resetOverride: (id) => {
    delete DEFAULT_OVERRIDES[id]
  },
  sessionOverrides: () => DEFAULT_OVERRIDES,
  save: async () => {
    await writeKnobConfig({ ...DEFAULT_OVERRIDES }, defaultConfigPath())
  },
  get configPath() {
    return defaultConfigPath()
  },
}

/** BUILTINS-registered `/knobs` instance. Holds a module-level session
 *  overrides bag so multi-invocation flow (`set` → `show` → `save`) is
 *  consistent within a single process. */
export const knobsCmd: SlashCommand = buildKnobsSlash(defaultWire)

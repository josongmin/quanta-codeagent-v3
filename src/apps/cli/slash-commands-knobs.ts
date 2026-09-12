/**
 * `/knobs` slash command family — CLI surface adapter over the `@/runner/knobs`
 * framework (SOTA++ knob registry).
 *
 * Subcommands:
 *   - `/knobs show`            (default) compact box of currently active knobs
 *   - `/knobs list`            full inventory (all 12 registered) + active marks
 *   - `/knobs set <id>=<val>`  session-level override (writes the ONE shared
 *                              `@/shared/knob-overrides` store — re-resolved on
 *                              next read; live for hot-toggleable knobs)
 *   - `/knobs reset <id>`      remove a session override
 *   - `/knobs preset <name>`   apply a named preset bundle as session overrides
 *   - `/knobs save`            persist session overrides → `~/.quanta/knobs.json`
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

import { join } from "node:path"
import {
  type AnyKnob,
  allKnobs,
  KNOB_PRESETS,
  type KnobValueMap,
  knobsForSurface,
  resolveKnobs,
  saveKnobConfigMerged,
} from "@/runner/knobs"
import { errMessage, getKnobOverride, knobOverrides, quantaHomeDir } from "@/shared"
import { setCliKnobOverride } from "./cli-knobs-accessor"
import {
  buildKnobCatalog,
  catalogByGroup,
  displaySafeValue,
  knobEnumValues,
  resolveCatalogValues,
  searchCatalog,
  type UnifiedKnob,
} from "./knob-catalog-wire"
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

const SUBCOMMANDS = [
  "show",
  "list",
  "all",
  "find",
  "set",
  "reset",
  "preset",
  "save",
  "help",
] as const
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
      case "all":
        return renderAll(ctx)
      case "find":
        return renderFind(args.slice(1).join(" "), ctx)
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

/* ─── /knobs all | find (UNIFIED catalog — all 200+ knobs, ADR-0503 P3) ── */

/** One compact catalog line: `QUANTA_X = value  ·describe` with a home tag. */
const catalogLine = (k: UnifiedKnob, raw: string | undefined, isDefault: boolean): string => {
  const val = raw === undefined ? "-" : raw
  const mark = isDefault ? "" : "*" // '*' = overridden (non-default)
  const tag = k.home === "cli" ? "" : ` [${k.home}]`
  return `  ${k.envKey}=${val}${mark}${tag}  — ${k.describe}`
}

/** `/knobs all` — the FULL unified catalog (cli + inventory + runner), grouped,
 *  with each knob's current value + source. This is the discoverability surface
 *  the 3-registry split otherwise hides. */
const renderAll = (ctx: SlashContext): number => {
  const catalog = buildKnobCatalog()
  // Session overrides come from the ONE shared store (`@/shared/knob-overrides`)
  // so a `/knobs set` is visible here immediately (WS-D UUX-6-04).
  const values = resolveCatalogValues(catalog, process.env, knobOverrides())
  const grouped = catalogByGroup(catalog)
  ctx.out(`All ${catalog.size} knobs ('*' = overridden; [home] = non-CLI):\n`)
  for (const [group, knobs] of grouped) {
    ctx.out(`\n${group} (${knobs.length})\n`)
    for (const k of knobs) {
      const v = values.get(k.envKey)
      ctx.out(
        `${catalogLine(k, displaySafeValue(k.kind, v?.raw, v?.source), v?.isDefault ?? true)}\n`,
      )
    }
  }
  return 0
}

/** `/knobs find <query>` — fuzzy search across the unified catalog (envKey +
 *  describe + group), envKey-prefix ranked first. */
const renderFind = (query: string, ctx: SlashContext): number => {
  if (query.trim().length === 0) {
    ctx.err("/knobs find: needs a query (e.g. /knobs find memory)\n")
    return 1
  }
  const catalog = buildKnobCatalog()
  const values = resolveCatalogValues(catalog, process.env, knobOverrides())
  const hits = searchCatalog(catalog, query)
  if (hits.length === 0) {
    ctx.out(`No knob matches "${query}".\n`)
    return 0
  }
  ctx.out(`${hits.length} knob(s) matching "${query}":\n`)
  for (const k of hits) {
    const v = values.get(k.envKey)
    ctx.out(`${catalogLine(k, v?.raw, v?.isDefault ?? true)}\n`)
  }
  return 0
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

/**
 * The CATALOG backend of `/knobs set`: a knob addressed by envKey
 * (cli / inventory / runtime-config) rather than by @/runner registry id.
 *
 * Returns the exit code, or `undefined` to mean "not a catalog knob either" so
 * the caller can emit the unknown-knob diagnostic. ONE unit because the three
 * gates below (kind validation, enum membership, security-boundary refusal) are
 * all facts about the CATALOG path; in the original they sat nested two levels
 * inside `doSet` and carried the nesting surcharge that dominated its score.
 */
const setCatalogKnob = (id: string, raw: string, ctx: SlashContext): number | undefined => {
  const cat = buildKnobCatalog().get(id)
  if (cat === undefined) return undefined
  // Validate raw against kind (parity with the runner path's fail-fast —
  // don't silently store a garbage numeric that the reader will drop).
  if ((cat.kind === "int" || cat.kind === "float") && !Number.isFinite(Number(raw.trim() || "x"))) {
    ctx.err(`/knobs set: ${id} expects ${cat.kind}, got: ${JSON.stringify(raw)}\n`)
    return 1
  }
  const allowed = cat.kind === "enum" ? knobEnumValues(id) : undefined
  if (allowed !== undefined && !allowed.includes(raw)) {
    ctx.err(
      `/knobs set: ${id} must be one of {${allowed.join(", ")}}, got: ${JSON.stringify(raw)}\n`,
    )
    return 1
  }
  if (!setCliKnobOverride(id, raw)) {
    ctx.err(
      `/knobs set: ${id} is a security-boundary knob — set it via env / managed config only, not a session override.\n`,
    )
    return 1
  }
  // `hotToggleable` is the canonical liveness field and it is REQUIRED on every
  // catalog row, so this is a fact the catalog already carries — not a new one.
  //
  // The original line claimed `(session override; live this session)`
  // unconditionally, for all 674 rows, while at the time exactly ONE row was
  // `hotToggleable: true` and its own source said that apply path was dead — so
  // the sentence was false on every row a user could reach.
  //
  // `1ac18b507` then corrected that row (`QUANTA_PERSONA`) to `false` in the same
  // commit, so ZERO rows are hot-toggleable and the `true` branch below is
  // currently UNREACHABLE for every knob. `knobs-set-liveness-honesty-hellgate`
  // pins the count at zero as a measured fact. The branch is kept rather than
  // deleted because the field is the declared contract and a knob with a real
  // apply path would use it; if the count stays zero, the branch and the field
  // should go together, not one without the other.
  //
  // The first replacement said "run `/knobs save` and restart, or export it, to
  // take effect", and half of that is also false. `/knobs save` does write the
  // file, but NOTHING in production reads it back: `readCliKnob`'s chain is
  // session-override -> env -> registry default (`cli-knobs-accessor.ts`
  // `resolveRaw`), with no config-file layer, and `bootstrapKnobs` — the only code
  // that resolves `knobs.json` — has zero production callers and says so itself
  // ("the file is write-only in prod today", `knobs-bootstrap.ts`). Measured: set,
  // save, restart with the same QUANTA_HOME, and the knob reads its default.
  // A message that tells the operator to run a command that does nothing is the
  // exact defect this file was edited to remove.
  //
  // `export` is the only advice that is true, so it is the only advice given.
  ctx.out(
    cat.hotToggleable === true
      ? `/knobs: ${id} = ${raw} (session override; live this session)\n`
      : `/knobs: ${id} = ${raw} (session override stored — this knob is read once at ` +
          `startup, so the running session keeps its current value; ` +
          `export ${cat.envKey ?? id}=${raw} to apply it)\n`,
  )
  return 0
}

/**
 * The REGISTRY backend of `/knobs set`: an @/runner knob addressed by id.
 * ONE unit because it owns the throw→stderr conversion and the
 * not-hot-toggleable warning, neither of which the catalog path has.
 */
const setRegistryKnob = (
  id: string,
  raw: string,
  wire: KnobsSurfaceWire,
  ctx: SlashContext,
): number => {
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
  if (allKnobs().get(id) !== undefined) return setRegistryKnob(id, raw, wire, ctx)
  // Not an @/runner knob (id-keyed). It may be a catalog knob addressed by
  // envKey (cli/inventory/runtime-config) — route to the CLI accessor's
  // session bag so reads via readCliKnob (ADR-0503 P4) pick it up live.
  const catalogCode = setCatalogKnob(id, raw, ctx)
  if (catalogCode !== undefined) return catalogCode
  ctx.err(`/knobs set: unknown knob: ${id}\n`)
  return 1
}

/* ─── /knobs reset <id> ─────────────────────────────────────────────── */

const doReset = (args: readonly string[], wire: KnobsSurfaceWire, ctx: SlashContext): number => {
  if (args.length !== 1) {
    ctx.err("/knobs reset: expected exactly one argument (knob id)\n")
    return 1
  }
  const id = args[0] as string
  if (allKnobs().get(id) === undefined) {
    // catalog knob (envKey) — clear its CLI-accessor session override.
    //
    // This branch printed "cleared" unconditionally, so `/knobs reset QUANTA_X`
    // in a session that never set anything reported a clear that did not happen,
    // while `/knobs reset <runner-id>` twelve lines below correctly said "no-op".
    // Exactly the per-spelling asymmetry `1ac18b507` removed from `/knobs set`,
    // left in place two functions away.
    if (buildKnobCatalog().has(id)) {
      if (getKnobOverride(id) === undefined) {
        ctx.out(`/knobs: ${id} had no session override (no-op)\n`)
        return 0
      }
      setCliKnobOverride(id, undefined)
      ctx.out(`/knobs: ${id} session override cleared\n`)
      return 0
    }
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
  const warnings: string[] = []
  for (const [id, raw] of Object.entries(preset)) {
    if (allKnobs().get(id) === undefined) {
      skipped.push(id)
      continue
    }
    try {
      // UUX-4-21: the hot-toggle warning computed here used to be dropped on
      // the floor — a preset full of boot-frozen knobs printed "applied N"
      // as if everything were live. Surface every warning.
      const warning = wire.setOverride(id, raw)
      applied.push(`${id}=${raw}`)
      if (warning !== undefined) warnings.push(`${id}: ${warning}`)
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
  for (const w of warnings) {
    ctx.out(`  warning: ${w}\n`)
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
  "/knobs all              — full UNIFIED catalog (all 200+ knobs, grouped)",
  "/knobs find <query>     — search the unified catalog by name/desc/group",
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

/** Default wire used by the BUILTINS-registered `/knobs` command.
 *
 *  WS-D (jul-10, UUX-6-04) — ONE override store. The wire holds NO state of
 *  its own: every method is a pure projection over the process-level
 *  `@/shared/knob-overrides` store (the declared SSOT that `runtimeConfig()`
 *  and `readCliKnob()` already consult). The previous module-level
 *  `DEFAULT_OVERRIDES` bag was a THIRD knob store: `set` on a catalog knob
 *  wrote the shared store while `show`/`save` read the bag — `/knobs save`
 *  persisted a store the user never changed, and runner-knob sets were
 *  invisible to every live reader. Two projections replace it:
 *
 *    - {@link runnerSessionOverrides} — the shared store viewed through the
 *      runner registry's `id` keys (what `resolveKnobs`' session layer and
 *      the persisted config-file layer expect).
 *    - {@link persistableOverrides} — the FULL shared-store snapshot for
 *      `/knobs save`: runner knobs land under their `id` (config-file layer
 *      round-trip), everything else under its raw `envKey`.
 *
 *  Surfaces that need their own scoped wire (a multi-session host, for
 *  instance) should call {@link buildKnobsSlash} directly with a fresh wire
 *  and bypass this default registration. */
const defaultConfigPath = (): string => join(quantaHomeDir(), "knobs.json")

/** Shared-store snapshot projected onto runner-knob ids (session layer of
 *  `resolveKnobs`). Runner knobs are addressed by `id` in that layer; the
 *  shared store keys by `envKey` — this is the (stateless) translation. */
const runnerSessionOverrides = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [id, knob] of allKnobs()) {
    const raw = getKnobOverride(knob.envKey)
    if (raw !== undefined) out[id] = raw
  }
  return out
}

/** Full persistable snapshot of the ONE store: runner overrides under their
 *  registry `id` (so the config-file layer reads them back), non-runner
 *  (catalog/envKey-addressed) overrides under their `envKey` verbatim. */
const persistableOverrides = (): Record<string, string> => {
  const runner = runnerSessionOverrides()
  const runnerEnvKeys = new Set([...allKnobs().values()].map((k) => k.envKey))
  const out: Record<string, string> = {}
  for (const [envKey, raw] of Object.entries(knobOverrides())) {
    if (!runnerEnvKeys.has(envKey)) out[envKey] = raw
  }
  return { ...out, ...runner }
}

const defaultResolve = (): KnobValueMap =>
  resolveKnobs({
    surface: "cli",
    knobs: knobsForSurface("cli"),
    sessionOverrides: runnerSessionOverrides(),
    envVars: process.env,
  })

const defaultWire: KnobsSurfaceWire = {
  resolution: defaultResolve,
  setOverride: (id, raw) => {
    const knob = allKnobs().get(id)
    // Route through the SAME chokepoint the catalog path uses so the
    // security-boundary carve-out holds for runner knobs too. A refusal is
    // fail-closed: no store write, surfaced as stderr + exit 1 by `doSet`.
    const envKey = knob?.envKey ?? id
    if (!setCliKnobOverride(envKey, raw)) {
      throw new Error(
        `${id} is a security-boundary knob — set it via env / managed config only, not a session override`,
      )
    }
    // Surface a non-fatal warning when the knob is read once at boot and cannot
    // take effect mid-session. `hotToggleable` DEFAULTS to false (types.ts), so
    // only an explicit `true` suppresses the warning — an undeclared knob must not
    // be advertised as live (UUX-4-21 honesty).
    //
    // This used to say "saved for next session", which `1ac18b507` cited as the
    // path that "has warned correctly the whole time" and used as its correctness
    // reference. It has not: `/knobs save` writes `knobs.json` and no production
    // code reads it back, so the next session does NOT pick the override up. The
    // reference was itself false, in the same direction.
    if (knob !== undefined && knob.hotToggleable !== true) {
      return (
        `knob '${id}' is not hot-toggleable — the override applies only to later reads ` +
        `in this session; export ${envKey}=${raw} to apply it at startup`
      )
    }
    return undefined
  },
  resetOverride: (id) => {
    const knob = allKnobs().get(id)
    setCliKnobOverride(knob?.envKey ?? id, undefined)
  },
  sessionOverrides: persistableOverrides,
  save: async () => {
    // Merge-on-save (jun-10 silent-failure audit #18): a wholesale
    // `writeKnobConfig(bag)` from this process's (possibly empty) bag wiped
    // every other session's saved knobs while still printing "saved N
    // override(s)". Fresh-read the persisted user_defaults + overlay instead.
    await saveKnobConfigMerged(persistableOverrides(), defaultConfigPath())
  },
  get configPath() {
    return defaultConfigPath()
  },
}

/** BUILTINS-registered `/knobs` instance. Holds a module-level session
 *  overrides bag so multi-invocation flow (`set` → `show` → `save`) is
 *  consistent within a single process. */
export const knobsCmd: SlashCommand = buildKnobsSlash(defaultWire)

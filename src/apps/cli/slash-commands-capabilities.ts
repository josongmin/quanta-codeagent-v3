/**
 * `/capabilities` (alias `/caps`) slash command — operator-facing READ-ONLY
 * surface over the cross-surface capability layer (`@/capability`, ADR-0503 P3 /
 * RFC §4).
 *
 * The capability layer is the single SSOT that maps each gated feature to (a) the
 * env gate that arms it and (b) the invocation surfaces it exposes on (llmTool /
 * slash / skill / hook / thinClient). `resolveExposure(cap, surface, env)` is the
 * ONE place a capability's exposure on a surface is decided. This command renders
 * that resolution for the operator so the otherwise-invisible split-brain surface
 * matrix is discoverable.
 *
 * Subcommands:
 *   - `/capabilities` | `/capabilities list`  (default) — full table: id,
 *     describe, gate (envKey + current on/off), and a per-surface exposure grid
 *     (✓ exposed / ✗ declared-but-off / – not-declared) computed via
 *     `resolveExposure(cap, surface, process.env)`.
 *   - `/capabilities find <q>` — filter by id / describe / gate envKey.
 *   - `/capabilities help` — family summary.
 *
 * Mirrors the `/knobs` slash contract (`SlashCommand`, `ctx.out`/`ctx.err`,
 * completion adapter). This command DISPLAYS only — it never mutates env, gates,
 * or the registry. The master gate (QUANTA_CAPABILITY_LAYER) state is shown at the
 * top; when OFF the resolver is probe-only and the legacy per-surface gates are
 * authoritative (the grid still reflects what the unified resolver WOULD decide).
 */

import {
  type CapabilityDescriptor,
  CAPABILITY_LAYER_ENV,
  type Surface,
  allCapabilities,
  resolveExposure,
} from "@/capability"
import { gateOn } from "@/shared"
import type { SlashCommand, SlashCompletionHint, SlashContext } from "./slash-contract"

const SUBCOMMANDS = ["list", "find", "help"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
const isSubcommand = (s: string): s is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(s)

/** Surfaces rendered in the exposure grid, in column order. */
const SURFACES: readonly Surface[] = ["llmTool", "slash", "skill", "hook", "thinClient"]

/** Per-surface exposure marker:
 *   ✓ — declared AND gate on (exposed via `resolveExposure`)
 *   ✗ — declared but gate off (would expose once armed)
 *   – — not declared on this surface (en-dash). */
const exposureMark = (
  cap: CapabilityDescriptor,
  surface: Surface,
  env: Record<string, string | undefined>,
): string => {
  if (cap.surfaces[surface] !== true) return "–"
  return resolveExposure(cap, surface, env) ? "✓" : "✗"
}

const COL = 10 // surface column width (header label "thinClient" = 10)

const gridHeader = (): string => SURFACES.map((s) => s.padEnd(COL)).join(" ")

const gridRow = (cap: CapabilityDescriptor, env: Record<string, string | undefined>): string =>
  SURFACES.map((s) => exposureMark(cap, s, env).padEnd(COL)).join(" ")

/** Render the master-gate banner. When OFF, note that the layer is probe-only
 *  and the legacy per-surface gates remain authoritative. */
const renderBanner = (env: Record<string, string | undefined>, ctx: SlashContext): void => {
  const on = gateOn(env, CAPABILITY_LAYER_ENV)
  if (on) {
    ctx.out(`master gate: ${CAPABILITY_LAYER_ENV} = on\n`)
  } else {
    ctx.out(
      `master gate: ${CAPABILITY_LAYER_ENV} = off  (probe-only; legacy per-surface gates authoritative)\n`,
    )
  }
}

/** Render one capability block: header line (id + gate), describe, exposure row. */
const renderCapability = (
  cap: CapabilityDescriptor,
  env: Record<string, string | undefined>,
  ctx: SlashContext,
): void => {
  const gateState = gateOn(env, cap.gate.envKey) ? "on" : "off"
  ctx.out(`\n${cap.id}  [gate: ${cap.gate.envKey} = ${gateState}]\n`)
  ctx.out(`  ${cap.describe}\n`)
  ctx.out(`  ${gridRow(cap, env)}\n`)
}

const renderList = (ctx: SlashContext): number => {
  const env = process.env
  const caps = allCapabilities()
  renderBanner(env, ctx)
  ctx.out(`${caps.length} capabilities (✓ exposed · ✗ declared-but-off · – not-declared)\n`)
  ctx.out(`  surfaces: ${gridHeader()}\n`)
  for (const cap of caps) renderCapability(cap, env, ctx)
  return 0
}

/** `/capabilities find <q>` — filter by id / describe / gate envKey (case-
 *  insensitive substring). */
const renderFind = (query: string, ctx: SlashContext): number => {
  if (query.trim().length === 0) {
    ctx.err("/capabilities find: needs a query (e.g. /capabilities find workflow)\n")
    return 1
  }
  const q = query.trim().toLowerCase()
  const env = process.env
  const hits = allCapabilities().filter(
    (c) =>
      c.id.toLowerCase().includes(q) ||
      c.describe.toLowerCase().includes(q) ||
      c.gate.envKey.toLowerCase().includes(q),
  )
  if (hits.length === 0) {
    ctx.out(`No capability matches "${query}".\n`)
    return 0
  }
  renderBanner(env, ctx)
  ctx.out(`${hits.length} capability(ies) matching "${query}":\n`)
  ctx.out(`  surfaces: ${gridHeader()}\n`)
  for (const cap of hits) renderCapability(cap, env, ctx)
  return 0
}

const FAMILY_HELP = [
  "/capabilities            — alias for `/capabilities list`",
  "/capabilities list       — render every capability + gate + per-surface grid",
  "/capabilities find <q>   — filter by id / describe / gate envKey",
  "/capabilities help       — this menu",
  "",
  "grid markers: ✓ exposed · ✗ declared-but-off · – not-declared",
  "(alias: /caps)",
].join("\n")

const doHelp = (ctx: SlashContext): number => {
  ctx.out(`${FAMILY_HELP}\n`)
  return 0
}

type Hint = SlashCompletionHint
const hintsFrom = (xs: readonly string[], seed: string): readonly Hint[] =>
  xs.filter((x) => x.startsWith(seed)).map((value) => ({ value, kind: "argument" as const }))

/** Completion adapter — subcommands at slot 0; no further arg hints (find takes
 *  a free-text query). */
const completeCapabilities = (args: readonly string[], partial: string): readonly Hint[] => {
  if (args.length === 0) return hintsFrom(SUBCOMMANDS as readonly string[], partial)
  return []
}

/** Build the `/capabilities` slash command. Read-only: no wire/state needed. */
const buildCapabilitiesSlash = (name: string): SlashCommand => ({
  name,
  category: "config",
  describe: "Show the cross-surface capability layer (gates + per-surface exposure grid)",
  complete: completeCapabilities,
  async run(args, ctx) {
    const sub = args[0] ?? "list"
    if (!isSubcommand(sub)) {
      ctx.err(`${name}: unknown subcommand: ${sub} (use one of ${SUBCOMMANDS.join(", ")})\n`)
      return 1
    }
    switch (sub) {
      case "list":
        return renderList(ctx)
      case "find":
        return renderFind(args.slice(1).join(" "), ctx)
      case "help":
        return doHelp(ctx)
    }
  },
})

/** BUILTINS-registered `/capabilities` instance (read-only; no session state). */
export const capabilitiesCmd: SlashCommand = buildCapabilitiesSlash("/capabilities")

/** `/caps` alias — same behavior, alias name surfaced in help/completion. */
export const capsAliasCmd: SlashCommand = buildCapabilitiesSlash("/caps")

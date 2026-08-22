/**
 * `/presets` — §9.6 opusplan-style sticky model PRESET selector (Claude-Code
 * `opusplan` parity). FIRST consumer of the producer-only `model-preset` slice.
 *
 *   /presets            → list every built-in preset (name · describe · its
 *                         role→model bindings + default), marking the active one.
 *   /presets <name>     → apply the preset via `StickyPresetResolver.select`, so
 *                         the session's per-role model resolution becomes STICKY
 *                         to that preset's bindings for the rest of the run.
 *   /presets clear      → drop the sticky selection (role resolution reverts to
 *                         the caller's per-turn fallback, verbatim).
 *
 * This command does NOT reimplement presets: it renders `listModelPresets()`
 * and mutates the SAME live `StickyPresetResolver` (`ctx.presets`) the session
 * loop consults each turn. An unknown name returns the resolver's TYPED
 * `{ok:false}` rejection (never a silent default) and the sticky selection is
 * left UNCHANGED — a bad name never clears a good pick.
 *
 * Lives in the SESSION registry layer (ADR-0306): it imports `@/llm` for the
 * preset registry/types, which the surface-only fence forbids but the session
 * per-command modules are permitted.
 *
 * Present iff surface-compose wired `ctx.presets`; absent ⇒ "not wired in this
 * surface" + exit 0 (default-OFF byte-identical parity with the rest of the
 * presence-gated commands).
 */

import { listModelPresets, type ModelPreset } from "@/llm"
import type { Role } from "@/llm/role-model-override/types"
import type { SlashCommand, SlashContext } from "../slash-contract"

type PresetWire = NonNullable<SlashContext["presets"]>

/** Stable, EXHAUSTIVE render order for a preset's role bindings. Typed as the
 *  closed `Role` union so adding a role is a compile error here (forces this
 *  discoverability surface to render it) rather than a silent omission. */
const ROLE_RENDER_ORDER: readonly Role[] = [
  "plan-writer",
  "executor",
  "reviewer",
  "explorer",
  "default",
]

/** One rendered block for a single preset: header (marked when active) + its
 *  default model + each BOUND role→model line (roles the preset does not name
 *  are omitted — they simply inherit `defaultModel`, already shown). */
const renderPreset = (p: ModelPreset, active: boolean): string => {
  const mark = active ? "* " : "  "
  const lines: string[] = [`${mark}${p.name} — ${p.describe}`, `    default: ${p.defaultModel}`]
  for (const role of ROLE_RENDER_ORDER) {
    const model = p.roles[role]
    if (model !== undefined && model !== "") lines.push(`    ${role}: ${model}`)
  }
  return `${lines.join("\n")}\n`
}

/** No-arg path — list every preset, marking the active one, + a use hint. */
const renderList = (presets: PresetWire, out: (s: string) => void): void => {
  const active = presets.selected()
  const all = listModelPresets()
  out("🎛️  model presets (sticky per-run role→model bundles):\n")
  if (all.length === 0) out("  (none registered)\n")
  else for (const p of all) out(renderPreset(p, p.name === active?.name))
  out("use: /presets <name>   (or /presets clear to drop the sticky pick)\n")
}

/** The valid-name list for an unknown-name error (SSOT: the live registry). */
const validNames = (): string => {
  const names = listModelPresets().map((p) => p.name)
  return names.length > 0 ? names.join(", ") : "(none)"
}

export const presetsCmd: SlashCommand = {
  name: "/presets",
  describe: "List or apply a sticky model preset (opusplan-style role→model bundle)",
  category: "config",

  async run(args, ctx): Promise<number> {
    const presets = ctx.presets
    if (presets === undefined) {
      ctx.out("/presets: not wired in this surface (model-preset resolver unavailable)\n")
      return 0
    }

    if (args.length === 0) {
      renderList(presets, ctx.out)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/presets: takes at most one preset name; got ${args.length}\n`)
      return 1
    }

    const name = args[0] as string

    // /presets clear — drop the sticky selection.
    if (name === "clear") {
      presets.clear()
      ctx.out("/presets: cleared — role→model resolution reverts to the per-turn default.\n")
      return 0
    }

    // /presets <name> — apply STICKILY via the resolver. Rejection ⇒ TYPED
    // {ok:false}; the sticky selection is left UNCHANGED (no silent fallback).
    // Honor the typed error CODE: only `unknown-preset` gets the valid-name
    // enumeration. The `PresetError` class explicitly anticipates future codes
    // ("attach without a breaking shape") — surfacing the code verbatim keeps a
    // NEW rejection reason from being mislabeled "unknown preset" here.
    const res = presets.select(name)
    if (!res.ok) {
      ctx.err(
        res.error.code === "unknown-preset"
          ? `/presets: unknown preset '${name}'; valid presets = ${validNames()}\n`
          : `/presets: cannot apply '${name}' — ${res.error.code}: ${res.error.message}\n`,
      )
      return 1
    }
    ctx.out(
      `🎛️  preset applied: ${name} — role→model resolution is now sticky to it for this run.\n` +
        "  Run /presets to see the bindings, or /presets clear to drop it.\n",
    )
    return 0
  },

  complete(args, partial, ctx) {
    if (ctx.presets === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    const names = listModelPresets().map((p) => p.name)
    return [...names, "clear"]
      .filter((n) => n.toLowerCase().startsWith(seed))
      .map((n) => ({ value: n, kind: "argument" as const }))
  },
}

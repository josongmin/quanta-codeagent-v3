/**
 * Knob: `skills` — wire the Tier-1 skill system (ADR-0011 / ADR-0045).
 *
 * Default-OFF. Migrated verbatim from the `QUANTA_BENCH_SKILLS=1` resolve path
 * in `src/runner/batch/eval/driver.ts` `benchOptIns()`. Apply sets
 * `cfg.skills = {}` — bench never points at a user dir (measurement integrity:
 * bundled-only). `changedPaths` is left unset (full inventory).
 *
 * Strict truthy gate: only `"1"` / `"on"` / `"true"` parse to `true`; anything
 * else ⇒ `undefined`. No heuristics.
 */

import type { AgentConfig } from "@/agent"
import { skillsSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench", "agent-batch", "agent-interactive"]

/** Non-NOOP apply — wires `cfg.skills`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applySkills = (
  cfg: AgentConfig,
  value: true,
  ctx: { surface: Surface },
): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, skills: cfg.skills ?? {} }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const skillsKnob = deriveKnob(skillsSchema, applySkills)

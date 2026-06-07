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
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench", "agent-batch", "agent-interactive"]
const TRUTHY = new Set(["1", "on", "true"])

const parseSkills = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? true : undefined
}

const applySkills = (cfg: AgentConfig, value: true, ctx: { surface: Surface }): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, skills: cfg.skills ?? {} }
}

export const skillsKnob: Knob<true> = {
  id: "skills",
  envKey: "QUANTA_BENCH_SKILLS",
  category: "agent",
  surfaces: SURFACES,
  parse: parseSkills,
  apply: applySkills,
  describe: "Wire the Tier-1 skill system (bundled-only; Skill / ToolSearch tools)",
  source: "ADR-0045",
}

registerKnob(skillsKnob)

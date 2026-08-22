/**
 * Knob: `subagent` — wire the Tier-1 subagent system (ADR-0011).
 *
 * Default-OFF posture (RFC §1.2). Migrated verbatim from the
 * `QUANTA_BENCH_SUBAGENT=1` resolve path in `src/runner/batch/eval/driver.ts`
 * `benchOptIns()`. Apply sets `cfg.subagent = {}` — bench never tunes
 * `maxDepth` / `taskRegistry` (measurement integrity).
 *
 * Strict truthy gate: only `"1"` / `"on"` / `"true"` parse to `true`; anything
 * else (including `"yes"`, `"True"`, `"0"`, garbage, empty, whitespace) ⇒
 * `undefined`. No heuristics.
 */

import type { AgentConfig } from "@/agent"
import { subagentSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

/** Non-NOOP apply — wires `cfg.subagent`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applySubagent = (
  cfg: AgentConfig,
  value: boolean,
  ctx: { surface: Surface },
): AgentConfig => {
  if (value !== true) return cfg
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, subagent: cfg.subagent ?? {} }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const subagentKnob = deriveKnob(subagentSchema, applySubagent)

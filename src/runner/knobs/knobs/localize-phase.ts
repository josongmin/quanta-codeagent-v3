/**
 * Knob: `localize-phase` — Agentless "localize-first" guard (Tier-0
 * absorption, Agentless paper §3.1).
 *
 * Default-OFF. `0` is the EXPLICIT-OFF env sentinel: it resolves as a real
 * env-layer value so it can suppress a preset-provided localize-phase instead
 * of falling through to that preset. Positive integers still apply
 * `cfg.localizePhase = { phase1Turns: N }`.
 *
 * Domain (ACTIVE):
 *   - `"0"` ⇒ explicit OFF sentinel `{ phase1Turns: 0 }` (env-layer disable).
 *   - integer N in [1, 20] ⇒ `{ phase1Turns: N }`.
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / empty string
 *   - non-numeric (`"garbage"`, `"1.5"`, `"abc"`)
 *   - negative / NaN / Infinity
 *   - > 20 (measurement-integrity cap — phase1Turns > 20 on a maxTurns=30 run
 *     would starve repair)
 *
 * Closed parser: explicit `Number.isFinite` + `Number.isInteger` checks (no
 * `parseInt`-then-coerce that would silently swallow "1abc" as 1). No
 * heuristics. The only special sentinel is the exact integer `0`, which means
 * "disable this knob even if a preset enabled it".
 *
 * Conflicts with `branch-search` — both strengthen explore; running them
 * together confounds A/B measurement.
 */

import type { AgentConfig } from "@/agent"
import { localizePhaseSchema } from "@/config/knob-schema/schemas/bench-loop"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

interface LocalizePhaseValue {
  readonly phase1Turns: number
}

/** Non-NOOP apply — folds `cfg.localizePhase`. Bound into the central registrar
 *  (`APPLY_BINDINGS` + conflicts) AND used to derive the back-compat knob export;
 *  ONE definition so the derived knob is byte-identical to the registered one. */
export const applyLocalizePhase = (
  cfg: AgentConfig,
  value: LocalizePhaseValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  if (value.phase1Turns === 0) return cfg
  return { ...cfg, localizePhase: { phase1Turns: value.phase1Turns } }
}

// DERIVED from the schema SSOT (data) + the runner-side apply + relationship
// bindings. Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const localizePhaseKnob = deriveKnob(localizePhaseSchema, applyLocalizePhase, {
  conflicts: ["branch-search"],
})

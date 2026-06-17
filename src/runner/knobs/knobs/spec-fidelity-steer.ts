/**
 * Knob: `spec-fidelity-steer` (gap-B, jun-17 strategy-failure-fix). When the
 * issue declares a concrete expected output (extractIssueDeclaredExpected returns
 * a value), append a 2-sentence steer telling the model to treat that public
 * expected output as the authoritative spec and prefer the MINIMAL literal fix.
 * Targets the 6/7 strategy failures (pylint-4970 sentinel, sympy-18763 over-eng,
 * sympy-23262 special-case, …).
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`specFidelitySteer`
 * field) — the steer text is appended in `buildConfig` ONLY when this knob is on
 * AND a concrete spec was extracted (fail-closed, so co-change cases like
 * sympy-15976/21930 are NOT nudged toward minimality). agentless-v1/v2 presets
 * are NOT touched — the experiment opens via env override only. Strict truthy
 * gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseSpecFidelitySteer = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applySpecFidelitySteer = (cfg: AgentConfig): AgentConfig => cfg

export const specFidelitySteerKnob: Knob<true> = {
  id: "spec-fidelity-steer",
  envKey: "QUANTA_BENCH_SPEC_FIDELITY_STEER",
  category: "tool",
  surfaces: SURFACES,
  parse: parseSpecFidelitySteer,
  apply: applySpecFidelitySteer,
  describe: "gap-B spec-fidelity steer (minimal-literal-fix; fires only when issue declares an exact expected output)",
  source: "jun-17 strategy-failure-fix plan (Top-1)",
}

registerKnob(specFidelitySteerKnob)

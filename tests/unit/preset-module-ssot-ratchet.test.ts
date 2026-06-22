/**
 * STRUCTURAL SSOT ratchet (jun-22 v5 / P2). Binds the composable presets to the
 * KnobModule catalog so the module catalog is the AUTHORITY: each preset literal
 * MUST equal `expandModules([BASE, ...delta])`. Editing either side without the
 * other fails this test — drift becomes impossible to ship.
 *
 * Why a ratchet instead of rewriting the literals to `expandModules(...)`: the
 * `-vN` presets are FROZEN by convention (`presets.ts` header: "NEVER edit a
 * `-vN` preset in place"; the bench snapshot trips on it) and bench reproducibility
 * keys on the literal. So the literals stay as the frozen reproducibility artifact
 * and this ratchet proves they ARE the module expansion. The runtime controller
 * already uses the same module arrays via PHASE_MODULES — one source, two folds
 * (build-time `expandModules` here, runtime `derivePhasePosture`).
 *
 * Frozen literals with NO clean module decomposition (true subtractions / legacy)
 * are intentionally NOT covered: baseline, agentless-v1 (the base itself),
 * agentless-v2(-safe), agentless-full, hint-only, everything.
 */

import { describe, expect, test } from "bun:test"
import {
  CLEAN_SELECTOR,
  CLOSURE_GROUNDING,
  CLOSURE_REPAIR,
  CLOSURE_SELECT_CLEAN_MODULES,
  COUNTERFACTUAL,
  expandModules,
  GATED_MODULES,
  type KnobModule,
  LLM_RISK_GATE,
  LOCALIZATION_CORE,
  MULTI_AGENT,
  PATCH_HYGIENE,
  PROOF_CLEAN_MODULES,
  REGRESSION,
  REPRO_DOUBT,
  REPRO_VOTE,
  ROUND0_MINIMAL,
  SELECT_EARLY_ACCEPT,
  SELECT_MODULES,
  SELECT_N,
  SELECT_REPRO_OFF,
  SELECT_REPRO_POSITIVE,
  STEER_OFF,
  THIN_BASE,
  THIN_STRICT_BASE,
} from "@/runner/batch/eval/posture"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

/** preset name → the module decomposition whose expansion must equal its literal. */
const DECOMPOSITION: Readonly<Record<string, readonly KnobModule[]>> = {
  // localization-core (v1) family
  "agentless-v1-nosteer": [LOCALIZATION_CORE, STEER_OFF],
  "agentless-mini-parity": [LOCALIZATION_CORE, CLOSURE_GROUNDING, PATCH_HYGIENE, ROUND0_MINIMAL],
  "everything-v1": [LOCALIZATION_CORE, MULTI_AGENT],
  "agentless-v2-repair": [LOCALIZATION_CORE, CLOSURE_GROUNDING, PATCH_HYGIENE, CLOSURE_REPAIR(3)],
  "agentless-v2-reprovote": [
    LOCALIZATION_CORE,
    CLOSURE_GROUNDING,
    PATCH_HYGIENE,
    CLOSURE_REPAIR(3),
    REPRO_VOTE,
  ],
  // bases as self (identity)
  "agentless-v3-thin": [THIN_BASE],
  "agentless-v3-thin-strict": [THIN_STRICT_BASE],
  // thin-strict family — reuse the SAME composite arrays the controller routes to
  "agentless-v3-thin-strict-gated": [THIN_STRICT_BASE, ...GATED_MODULES],
  "agentless-v3-thin-strict-select": [THIN_STRICT_BASE, ...SELECT_MODULES],
  "agentless-v3-thin-strict-closure-select-clean": [
    THIN_STRICT_BASE,
    ...CLOSURE_SELECT_CLEAN_MODULES,
  ],
  "agentless-v4-proof-clean": [THIN_STRICT_BASE, ...PROOF_CLEAN_MODULES],
  // thin-strict research arms (composed from primitives)
  "agentless-v3-thin-strict-counterfactual": [
    THIN_STRICT_BASE,
    SELECT_N(2),
    REGRESSION("discovered"),
    ...gateRest(),
    COUNTERFACTUAL,
  ],
  "agentless-v3-thin-strict-counterfactual-shadow": [
    THIN_STRICT_BASE,
    SELECT_N(2),
    REGRESSION("discovered"),
    ...gateRest(),
    COUNTERFACTUAL,
    LLM_RISK_GATE("shadow"),
  ],
  "agentless-v3-thin-strict-gated-llm-shadow": [
    THIN_STRICT_BASE,
    SELECT_N(2),
    REGRESSION("discovered"),
    riskGate(),
    SELECT_REPRO_OFF,
    LLM_RISK_GATE("shadow"),
  ],
  "agentless-v3-thin-strict-gated-llm": [
    THIN_STRICT_BASE,
    SELECT_N(2),
    REGRESSION("discovered"),
    riskGate(),
    SELECT_REPRO_OFF,
    LLM_RISK_GATE("on"),
  ],
  "agentless-v3-thin-strict-closure-select": [
    THIN_STRICT_BASE,
    SELECT_N(5),
    REGRESSION("discovered"),
    SELECT_EARLY_ACCEPT,
    SELECT_REPRO_POSITIVE,
    CLOSURE_GROUNDING,
  ],
  "agentless-v3-thin-strict-closure-select-clean-witness-only": [
    THIN_STRICT_BASE,
    SELECT_N(5),
    REGRESSION("discovered"),
    SELECT_REPRO_OFF,
    CLOSURE_GROUNDING,
    CLEAN_SELECTOR,
  ],
  // select-regression family over the v3-thin base
  "agentless-v3-select-regression": [
    THIN_BASE,
    SELECT_N(5),
    REGRESSION("discovered"),
    SELECT_EARLY_ACCEPT,
    SELECT_REPRO_POSITIVE,
  ],
  "agentless-v3-select-regression-doubt": [
    THIN_BASE,
    SELECT_N(5),
    REGRESSION("discovered"),
    SELECT_EARLY_ACCEPT,
    SELECT_REPRO_POSITIVE,
    REPRO_DOUBT(5),
  ],
}

// GATED_MODULES = [SELECT_N(2), REGRESSION, RISK_GATE, SELECT_REPRO_OFF, CLEAN_SELECTOR].
// The gated research arms reuse its tail (RISK_GATE + SELECT_REPRO_OFF [+ CLEAN]).
function riskGate(): KnobModule {
  return GATED_MODULES[2]! // RISK_GATE
}
function gateRest(): readonly KnobModule[] {
  return [GATED_MODULES[2]!, GATED_MODULES[3]!, GATED_MODULES[4]!] // RISK_GATE, SELECT_REPRO_OFF, CLEAN_SELECTOR
}

describe("preset ↔ module SSOT ratchet (P2)", () => {
  for (const [name, modules] of Object.entries(DECOMPOSITION)) {
    test(`${name} ≡ expandModules(decomposition)`, () => {
      const literal = KNOB_PRESETS[name]
      expect(literal, `preset ${name} must exist`).toBeDefined()
      expect(expandModules(modules)).toEqual({ ...literal })
    })
  }

  test("every composable preset is covered (only frozen/legacy excluded)", () => {
    const EXCLUDED = new Set([
      "baseline",
      "agentless-v1",
      "agentless-v2",
      "agentless-v2-safe",
      "agentless-full",
      "hint-only",
      "everything",
    ])
    const uncovered = Object.keys(KNOB_PRESETS).filter(
      (n) => !EXCLUDED.has(n) && !(n in DECOMPOSITION),
    )
    expect(uncovered).toEqual([])
  })
})

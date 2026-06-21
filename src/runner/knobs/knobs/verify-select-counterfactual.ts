/**
 * Knob: `verify-select-counterfactual` — counterfactual candidate seed for
 * verify-and-select.
 *
 * When enabled, sequential verify-select first generates candidate 0 (cand0).
 * When cand0 trips the structural risk gate, candidate 1 (cand1) is generated
 * from a COUNTERFACTUAL minimal-alternative seed (the smallest plausible
 * different fix) and bound to the structural contracts cand0 had to satisfy.
 * This widens late-selection diversity along the dimension the gate flagged,
 * instead of re-rolling the same generation distribution. Default-OFF so the
 * existing selector arms stay reproducible.
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver
 * (`posture.verifySelectCounterfactual`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelectCounterfactual = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  if (raw === "1" || raw === "true" || raw === "on") return true
  if (raw === "0" || raw === "false" || raw === "off") return false
  return undefined
}

const applyVerifySelectCounterfactual = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectCounterfactualKnob: Knob<boolean> = {
  id: "verify-select-counterfactual",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectCounterfactual,
  apply: applyVerifySelectCounterfactual,
  describe:
    "Verify-and-select counterfactual candidate: when cand0 trips structural risk, generate cand1 from a counterfactual minimal-alternative seed and bind it to structural contracts",
  unit: "toggle",
  costMultiplier: 1,
  source: "jun-21 counterfactual select",
}

registerKnob(verifySelectCounterfactualKnob)

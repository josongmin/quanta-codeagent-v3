/**
 * Knob: `verify-select-risk-gate` - adaptive strict@1 -> strict@2 expansion.
 *
 * When enabled, sequential verify-select first generates candidate 0. A pure
 * static gate inspects only the public issue text, the generated patch, and
 * owner evidence. Low-risk patches submit immediately without spending another
 * candidate. Risky patches spend the remaining verify-select budget and enter
 * late selection. Default-OFF so existing selector arms stay reproducible.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelectRiskGate = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "true" || raw === "on" ? true : undefined
}

const applyVerifySelectRiskGate = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectRiskGateKnob: Knob<true> = {
  id: "verify-select-risk-gate",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectRiskGate,
  apply: applyVerifySelectRiskGate,
  describe:
    "Verify-and-select: generate candidate 0 first, expand to N only when static risk triggers",
  unit: "toggle",
  costMultiplier: 1,
  source: "jun-21 adaptive thin-strict selector gate",
}

registerKnob(verifySelectRiskGateKnob)

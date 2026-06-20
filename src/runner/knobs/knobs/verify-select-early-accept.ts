/**
 * Knob: `verify-select-early-accept` — progressive cost guard for verify-select.
 *
 * When enabled, sequential verify-select can stop after the first generated
 * candidate that is admissible, touches only known closure owners when owners
 * exist, and has a hard positive regression/resolved signal. Soft-only repro
 * quorum stays ranking credit and never becomes stop authority. This keeps
 * N-best as a fallback, not a mandatory cost multiplier. Default-OFF so existing
 * verify-select arms remain reproducible unless a preset opts in.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelectEarlyAccept = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "true" || raw === "on" ? true : undefined
}

const applyVerifySelectEarlyAccept = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectEarlyAcceptKnob: Knob<true> = {
  id: "verify-select-early-accept",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectEarlyAccept,
  apply: applyVerifySelectEarlyAccept,
  describe: "Verify-and-select: stop after first owner-scoped hard-positive candidate",
  unit: "toggle",
  costMultiplier: 1,
  source: "verify-and-select Phase 2 (jun-20) — progressive early accept",
}

registerKnob(verifySelectEarlyAcceptKnob)

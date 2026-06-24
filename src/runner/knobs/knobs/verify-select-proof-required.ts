/**
 * Knob: `verify-select-proof-required` — clean submit gate for v4 proof-clean.
 *
 * When true, verify-select may submit only a candidate with POSITIVE executed
 * proof (currently public MWE patched-green or positive repro-consensus). Static
 * contracts, owner coverage, family coverage, and generic keep-green regression
 * evidence remain ranking/safety signals only.
 *
 * APPLY IS A NOOP — consumed out of band by the bench selector
 * (`posture.verifySelectProofRequired`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelectProofRequired = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "1" || s === "true" || s === "on") return true
  if (s === "0" || s === "false" || s === "off") return false
  return undefined
}

const applyVerifySelectProofRequired = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectProofRequiredKnob: Knob<boolean> = {
  id: "verify-select-proof-required",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectProofRequired,
  apply: applyVerifySelectProofRequired,
  describe:
    "Require positive executed public proof before verify-select may submit a candidate",
  costMultiplier: 1,
  source: "jun-22 v4 proof-clean submit gate",
}

registerKnob(verifySelectProofRequiredKnob)

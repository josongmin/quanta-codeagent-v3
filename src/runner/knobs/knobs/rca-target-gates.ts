/**
 * Knob: `rca-target-gates` — explicit opt-in for benchmark RCA recovery gates.
 *
 * This is deliberately NOT part of the general `agentless-v3-thin-strict-*`
 * profiles. It enables case-family predicates/steers derived from a postmortem
 * on known misses, so runs using it must be reported as targeted RCA recovery,
 * not as a clean general-purpose profile.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseRcaTargetGates = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  return v === "1" || v === "on" || v === "true" ? true : undefined
}

const applyRcaTargetGates = (cfg: AgentConfig): AgentConfig => cfg

export const rcaTargetGatesKnob: Knob<true> = {
  id: "rca-target-gates",
  envKey: "QUANTA_BENCH_RCA_TARGET_GATES",
  category: "validation",
  surfaces: SURFACES,
  parse: parseRcaTargetGates,
  apply: applyRcaTargetGates,
  describe:
    "Targeted SWE-bench RCA recovery gates; opt-in only, not valid for clean general-profile claims",
  unit: "toggle",
  costMultiplier: 1,
  source: "jun-21 our-only miss RCA quarantine",
}

registerKnob(rcaTargetGatesKnob)

/**
 * Knob: `verify-select-llm-risk-gate` — optional LLM semantic expansion gate
 * layered on top of the structural verify-select gate.
 *
 * Unset preserves structural-only behavior. Explicit values:
 *   - `shadow`: call the LLM gate and record its advisory in telemetry only.
 *   - `on` / `1` / `true`: let the LLM gate expand candidate 0 fail-closed.
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver
 * (`posture.verifySelectLlmRiskGate`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export type VerifySelectLlmRiskGateMode = "shadow" | "on"

const parseVerifySelectLlmRiskGate = (
  raw: string | undefined,
): VerifySelectLlmRiskGateMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "shadow") return "shadow"
  if (s === "on" || s === "1" || s === "true") return "on"
  return undefined
}

const applyVerifySelectLlmRiskGate = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectLlmRiskGateKnob: Knob<VerifySelectLlmRiskGateMode> = {
  id: "verify-select-llm-risk-gate",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectLlmRiskGate,
  apply: applyVerifySelectLlmRiskGate,
  describe: "Verify-and-select semantic expansion gate: shadow telemetry or fail-closed LLM expand",
  unit: "mode",
  costMultiplier: 1,
  source: "jun-21 llm semantic selector gate",
}

registerKnob(verifySelectLlmRiskGateKnob)

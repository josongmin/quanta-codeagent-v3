/**
 * Knob: `verify-select-llm-risk-gate` — DERIVED from `verifySelectLlmRiskGateSchema`
 * (the SSOT in `@/config/knob-schema/schemas/bench-b`). NOOP apply: consumed out
 * of band via the bench posture projection (`selection-risk-gate`). Registration
 * is CENTRAL (`registerBenchKnobs`); this file re-exports the derived knob + the
 * mode type for back-compat importers.
 */

import { verifySelectLlmRiskGateSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** LLM risk-gate mode (consumed by selection-risk-gate). */
export type VerifySelectLlmRiskGateMode = "shadow" | "on"

export const verifySelectLlmRiskGateKnob = deriveKnob(verifySelectLlmRiskGateSchema)

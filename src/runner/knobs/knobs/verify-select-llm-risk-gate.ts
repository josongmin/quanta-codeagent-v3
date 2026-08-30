/**
 * Knob: `verify-select-llm-risk-gate` — DERIVED from `verifySelectLlmRiskGateSchema`
 * (the SSOT in `@/config/knob-schema/schemas/bench-b`). NOOP apply: consumed out
 * of band via the bench posture projection (`selection-risk-gate`). Registration
 * is CENTRAL (`registerBenchKnobs`); this file re-exports the derived knob + the
 * mode type for back-compat importers.
 * envKey: `QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { verifySelectLlmRiskGateSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/knobs/derive"

/** LLM risk-gate mode (consumed by selection-risk-gate). */
export type VerifySelectLlmRiskGateMode = "shadow" | "on"

export const verifySelectLlmRiskGateKnob = deriveKnob(verifySelectLlmRiskGateSchema)

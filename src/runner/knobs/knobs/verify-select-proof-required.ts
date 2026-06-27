/**
 * Knob: `verify-select-proof-required` — DERIVED from `verifySelectProofRequiredSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-gap-1`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 */

import { verifySelectProofRequiredSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const verifySelectProofRequiredKnob = deriveKnob(verifySelectProofRequiredSchema)

/**
 * Knob: `verify-select-proof-required` — DERIVED from `verifySelectProofRequiredSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-gap-1`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { verifySelectProofRequiredSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/knobs/derive"

export const verifySelectProofRequiredKnob = deriveKnob(verifySelectProofRequiredSchema)

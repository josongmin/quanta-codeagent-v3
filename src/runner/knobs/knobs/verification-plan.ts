/**
 * Knob: `verification-plan` — DERIVED from `verificationPlanSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-a`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_VERIFICATION_PLAN` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { verificationPlanSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/knobs/derive"

export const verificationPlanKnob = deriveKnob(verificationPlanSchema)

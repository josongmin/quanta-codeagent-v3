/**
 * Knob: `spec-fidelity-steer` — DERIVED from `specFidelitySteerSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-a`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_SPEC_FIDELITY_STEER` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { specFidelitySteerSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const specFidelitySteerKnob = deriveKnob(specFidelitySteerSchema)

/**
 * Knob: `model-lane-diversity` — DERIVED from `modelLaneDiversitySchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-b`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_MODEL_LANE_DIVERSITY` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { modelLaneDiversitySchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const modelLaneDiversityKnob = deriveKnob(modelLaneDiversitySchema)

/**
 * Knob: `verify-select-regression` — DERIVED from `verifySelectRegressionSchema`
 * (the SSOT in `@/config/knob-schema/schemas/bench-c`). NOOP apply: consumed out
 * of band via the bench posture projection. Registration is CENTRAL
 * (`registerBenchKnobs`); this file re-exports the derived knob + the mode type
 * for back-compat importers (knobs-bench posture).
 */

import { verifySelectRegressionSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Regression-selection mode (consumed by the bench posture projection). */
export type VerifySelectRegressionMode = "discovered" | "gold" | "off"

export const verifySelectRegressionKnob = deriveKnob(verifySelectRegressionSchema)

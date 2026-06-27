/**
 * Knob: `verify-select-repro` — DERIVED from `verifySelectReproSchema` (the SSOT
 * in `@/config/knob-schema/schemas/bench-c`). NOOP apply: consumed out of band
 * via the bench posture projection. Registration is CENTRAL (`registerBenchKnobs`);
 * this file re-exports the derived knob + the mode type for back-compat importers.
 */

import { verifySelectReproSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Repro-selection mode (consumed by the bench posture projection). */
export type VerifySelectReproMode = "hard" | "positive" | "off"

export const verifySelectReproKnob = deriveKnob(verifySelectReproSchema)

/**
 * Knob: `verify-select-repro` — DERIVED from `verifySelectReproSchema` (the SSOT
 * in `@/config/knob-schema/schemas/bench-c`). NOOP apply: consumed out of band
 * via the bench posture projection. Registration is CENTRAL (`registerBenchKnobs`);
 * this file re-exports the derived knob + the mode type for back-compat importers.
 * envKey: `QUANTA_BENCH_VERIFY_SELECT_REPRO` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { verifySelectReproSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/knobs/derive"

/** Repro-selection mode (consumed by the bench posture projection). */
export type VerifySelectReproMode = "hard" | "positive" | "off"

export const verifySelectReproKnob = deriveKnob(verifySelectReproSchema)

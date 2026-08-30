/**
 * Knob: `patch-hygiene` — DERIVED from `patchHygieneSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-a`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_PATCH_HYGIENE` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { patchHygieneSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/knobs/derive"

export const patchHygieneKnob = deriveKnob(patchHygieneSchema)

/**
 * Knob: `no-patch-force-fraction` — DERIVED from `noPatchForceFractionSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-gap-3`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_NO_PATCH_FORCE_FRACTION` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { noPatchForceFractionSchema } from "@/config/knob-schema/schemas/bench-gap-3"
import { deriveKnob } from "@/runner/knobs/derive"

export const noPatchForceFractionKnob = deriveKnob(noPatchForceFractionSchema)

/**
 * Knob: `paired-control` — DERIVED from `pairedControlSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-b`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_PAIRED_CONTROL` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { pairedControlSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/knobs/derive"

export const pairedControlKnob = deriveKnob(pairedControlSchema)

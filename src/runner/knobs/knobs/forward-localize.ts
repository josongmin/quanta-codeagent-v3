/**
 * Knob: `forward-localize` — DERIVED from `forwardLocalizeSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-b`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_FORWARD_LOCALIZE` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { forwardLocalizeSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/knobs/derive"

export const forwardLocalizeKnob = deriveKnob(forwardLocalizeSchema)

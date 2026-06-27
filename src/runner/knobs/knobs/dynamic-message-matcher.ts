/**
 * Knob: `dynamic-message-matcher` — DERIVED from `dynamicMessageMatcherSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-b`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 */

import { dynamicMessageMatcherSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const dynamicMessageMatcherKnob = deriveKnob(dynamicMessageMatcherSchema)

/**
 * Knob: `retry-transient` — DERIVED from `retryTransientSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-loop`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 */

import { retryTransientSchema } from "@/config/knob-schema/schemas/bench-loop"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const retryTransientKnob = deriveKnob(retryTransientSchema)

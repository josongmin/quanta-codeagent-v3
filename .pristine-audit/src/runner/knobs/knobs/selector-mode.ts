/**
 * Knob: `selector-mode` — DERIVED from `selectorModeSchema` (the SSOT in
 * `@/config/knob-schema/schemas/bench-loop`). Picks the verify-and-select
 * candidate selector mode (clean / research). NOOP apply: consumed out of band
 * via the bench posture projection. Registration is CENTRAL (`registerBenchKnobs`);
 * this file re-exports the derived knob + the value type for back-compat importers.
 * envKey: `QUANTA_BENCH_SELECTOR_MODE` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { selectorModeSchema } from "@/config/knob-schema/schemas/bench-loop"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Selector mode (consumed by the bench posture projection). */
export type SelectorModeKnob = "clean" | "research"

export const selectorModeKnob = deriveKnob(selectorModeSchema)

/**
 * Knob: `bench-in-loop-exec` — DERIVED from `benchInLoopExecSchema` (the SSOT in
 * `@/config/knob-schema/schemas/bench-a`). Controls the bench agent's in-loop
 * execution authority (full / repro-only / off). NOOP apply: the EFFECT is
 * delivered out of band by the driver (`benchPostureFromState` → `inLoopExecMode`).
 * Registration is CENTRAL (`registerBenchKnobs`); this file re-exports the derived
 * knob + the value-mode type for back-compat importers (knobs-bench posture).
 */

import { benchInLoopExecSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Tri-state in-loop-exec mode (consumed by the bench posture projection). */
export type BenchInLoopExecModeKnob = "full" | "repro-only" | "off"

export const benchInLoopExecKnob = deriveKnob(benchInLoopExecSchema)

/**
 * Knob: `repro-vote` — DERIVED from `reproVoteSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-repro`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_REPRO_VOTE` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { reproVoteSchema } from "@/config/knob-schema/schemas/bench-repro"
import { deriveKnob } from "@/runner/knobs/derive"

export const reproVoteKnob = deriveKnob(reproVoteSchema)

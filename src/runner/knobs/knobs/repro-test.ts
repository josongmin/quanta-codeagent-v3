/**
 * Knob: `repro-test` — Agentless §3.3.1 reproduction-test K-sample generation.
 *
 * SINGLE SOURCE: this knob is DERIVED from `reproTestSchema` (the one declaration
 * in src/config/knob-schema/schemas/bench-repro.ts) — parse, describe,
 * default, costMultiplier, unit, source all come from there, and the inventory
 * entry derives from the SAME schema. No hand-written duplicate. APPLY is a NOOP
 * (the K value is consumed out of band by the bench driver via
 * `installReproTestHint`, not stored on `AgentConfig`), so no apply binding.
 */

import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import { reproTestSchema } from "@/config/knob-schema/schemas/bench-repro"

// DERIVED from the schema SSOT; registration is CENTRAL (`registerBenchKnobs`).
// No self-register here (the central registrar owns it — double-register collides).
export const reproTestKnob = deriveKnob(reproTestSchema)

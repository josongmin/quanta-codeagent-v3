/**
 * Knob: `lsp-cheap` — DERIVED from `lspCheapSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-gap-1`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_LSP_CHEAP` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { lspCheapSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/knobs/derive"

export const lspCheapKnob = deriveKnob(lspCheapSchema)

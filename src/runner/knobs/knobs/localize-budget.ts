/**
 * Knob: `localize-budget` — DERIVED from `localizeBudgetSchema` (the SSOT in
 * `@/config/knob-schema/schemas/bench-b`). The agentless one-shot localizer's
 * breadth dials (`topk`/`tree`/`files`/`chafiles`). NOOP apply: consumed out of
 * band (`posture.localizeBudget` → `agentlessLocalize` deps). Registration is
 * CENTRAL (`registerBenchKnobs`); this file re-exports the derived knob + the
 * value type for back-compat importers (knobs-bench posture + driver).
 */

import { localizeBudgetSchema } from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Localizer-breadth value (any subset of the four dials). */
export interface LocalizeBudgetValue {
  readonly topK?: number
  readonly maxTreeChars?: number
  readonly maxFiles?: number
  /** jun-25: # of localized candidate files given CHA sibling analysis in the
   *  multisite-steer path (replaces the frozen `CHA_MULTISITE_MAX_FILES`). */
  readonly chaMultisiteFiles?: number
}

export const localizeBudgetKnob = deriveKnob(localizeBudgetSchema)

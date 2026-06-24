/**
 * Knob: `forward-localize` (T3, jun-24 scaffold SOTA absorption). Occupies the
 * previously-inert `deeper_localize` adaptive route.
 *
 * When the adaptive controller selects `deeper_localize` (a localization-gap
 * signal — e.g. the coverage contract reports a required owner/consumer the
 * candidate set does not yet touch), this knob turns the next attempt's
 * localization into a FORWARD pass: the symbols the prior candidate actually
 * edited are traced to their CALL SITES (consumers), and those consumer files
 * are merged into the next generation's owner evidence. This surfaces a consumer
 * that backward grep / CHA did not initially localize (the 14315 shape) WITHOUT
 * bumping `localizeBudget` blindly.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`forwardLocalize`
 * field). The widened files are CANDIDATES for the next pass, never hard
 * `requiredFiles` — only a T1 static-edge / public-contract validation may make a
 * site a coverage requirement, so forward-localize cannot manufacture an
 * answer-key owner. Promotion still requires the frozen-slice A/B; a losing knob
 * is deleted, not left as a permanent research flag. Strict truthy gate:
 * `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseForwardLocalize = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyForwardLocalize = (cfg: AgentConfig): AgentConfig => cfg

export const forwardLocalizeKnob: Knob<true> = {
  id: "forward-localize",
  envKey: "QUANTA_BENCH_FORWARD_LOCALIZE",
  category: "tool",
  surfaces: SURFACES,
  parse: parseForwardLocalize,
  apply: applyForwardLocalize,
  describe:
    "T3 forward-localize: on the deeper_localize adaptive route, trace the prior candidate's edited symbols to their consumer call-sites and merge them into the next pass's owner evidence (occupies the deeper_localize no-op route)",
  source: "jun-24 scaffold SOTA absorption plan (T3)",
}

registerKnob(forwardLocalizeKnob)

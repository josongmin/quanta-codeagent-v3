/**
 * Knob: `issue-hint` — DERIVED from `issueHintSchema` (the SSOT in
 * `@/config/knob-schema/schemas/bench-a`). Issue-text hint mode (Agentless §3.1).
 * NOOP apply: the hint mode is consumed by the bench driver OUT OF BAND
 * (`prepareIssueHint` → `precomputedHint` string), not a field on `AgentConfig`.
 * Registration is CENTRAL (`registerBenchKnobs`); this file re-exports the derived
 * knob + the mode type for back-compat importers.
 */

import { issueHintSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

/** Issue-hint localization mode. */
export type IssueHintMode = "agentless" | "regex"

export const issueHintKnob = deriveKnob(issueHintSchema)

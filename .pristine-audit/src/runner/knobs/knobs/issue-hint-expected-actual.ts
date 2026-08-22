/**
 * Knob: `issue-hint-expected-actual` — DERIVED from `issueHintExpectedActualSchema` (the knob-schema SSOT in
 * `@/config/knob-schema/schemas/bench-a`). NOOP apply: the value is consumed
 * out of band by the bench driver via `benchPostureFromState` (posture path),
 * not folded onto `AgentConfig`. Registration is CENTRAL (`registerBenchKnobs`);
 * this file only re-exports the derived knob for back-compat importers.
 * envKey: `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import { issueHintExpectedActualSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

export const issueHintExpectedActualKnob = deriveKnob(issueHintExpectedActualSchema)

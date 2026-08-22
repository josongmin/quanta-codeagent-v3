/**
 * Benchmark pack (batch mode).
 *
 * The extra rule pushes the loop to STOP once it has a coherent patch + a verify
 * step, instead of burning turns on further investigation that won't change the
 * outcome. Wording is posture-NEUTRAL on purpose: this pack composes with any env
 * posture (a frozen graded sandbox OR the user's own non-graded machine), so it
 * must not assert "graded by an external harness" — that premise contradicts the
 * default/owned posture's "not a graded sandbox".
 */

import { CORE_RULES, type PromptRule } from "./core"

/** TASK-only rules for batch mode (env-independent — env posture is a SEPARATE
 *  axis composed by `buildSystemPrompt`, not baked into the pack). */
export const BATCH_RULES: readonly PromptRule[] = [
  {
    id: "R-NO-EXPLORE-OVER-EDIT",
    // NOTE: posture-NEUTRAL wording. This pack composes with any env posture
    // (frozen graded sandbox OR the user's own non-graded machine), so the rule
    // must NOT assert "graded by external harness / scoring delta" — that premise
    // contradicts the `default`/`owned` posture's "not a graded sandbox". The
    // behavioral push (land the edit, then verify; don't burn turns exploring) is
    // valid regardless of whether an external grader exists.
    lines: [
      "- [R-NO-EXPLORE-OVER-EDIT] Stop exploring once you have a coherent edit and",
      "  a verify step; further exploration without an edit does not improve the",
      "  outcome — land the change, then verify.",
    ],
  },
]

/** Batch-mode pack = core rules + the explore-over-edit gate. */
export const BENCHMARK_PACK: readonly PromptRule[] = [...CORE_RULES, ...BATCH_RULES]

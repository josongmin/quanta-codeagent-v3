/**
 * Task-runner pack (headless mode).
 *
 * Headless runs have no human in the loop — the agent gets one shot to
 * produce a coherent change for the task. Extra rule narrows the model
 * away from mid-turn deliberation (which costs turns without yielding
 * a deliverable when nobody is there to redirect).
 */

import { CORE_RULES, type PromptRule } from "./core"

/** TASK-only rules for headless mode (env-independent — env posture is a
 *  SEPARATE axis composed by `buildSystemPrompt`). */
export const HEADLESS_RULES: readonly PromptRule[] = [
  {
    id: "R-SINGLE-COHERENT",
    lines: [
      "- [R-SINGLE-COHERENT] You are running headless: produce ONE coherent change",
      "  addressing the task; do not explore alternatives mid-turn; one decisive",
      "  answer, not deliberation.",
    ],
  },
]

/** Headless-mode pack = core rules + the single-coherent directive. */
export const TASK_RUNNER_PACK: readonly PromptRule[] = [...CORE_RULES, ...HEADLESS_RULES]

/**
 * PR-agent pack (ci-bot mode).
 *
 * The agent runs as a CI bot on a PR. Reviewer attention is the bottleneck —
 * the loop must keep the diff small, summarize the WHY in the PR description,
 * and never push to the default branch. These three rules encode constraints
 * a human reviewer would otherwise have to enforce by rejection.
 */

import { CORE_RULES, type PromptRule } from "./core"

/** TASK-only rules for ci-bot mode (env-independent — env posture is a
 *  SEPARATE axis composed by `buildSystemPrompt`). */
export const PR_RULES: readonly PromptRule[] = [
  {
    id: "R-SMALL-DIFF",
    lines: [
      "- [R-SMALL-DIFF] PR-mode: keep the diff small and focused on the issue.",
      "  Do not refactor unrelated code. Do not reformat. Reviewer attention is",
      "  the bottleneck.",
    ],
  },
  {
    id: "R-EXPLAIN-IN-PR",
    lines: [
      "- [R-EXPLAIN-IN-PR] PR-mode: every non-trivial change must be summarized",
      "  in the PR description. State the WHY (not the WHAT — the diff shows",
      "  the what).",
    ],
  },
  {
    id: "R-NO-PUSH-MAIN",
    lines: [
      "- [R-NO-PUSH-MAIN] PR-mode: never push or commit to the default branch.",
      "  All changes land on a feature branch.",
    ],
  },
]

/** CI-bot-mode pack = core rules + small-diff / explain / no-push-main. */
export const PR_AGENT_PACK: readonly PromptRule[] = [...CORE_RULES, ...PR_RULES]

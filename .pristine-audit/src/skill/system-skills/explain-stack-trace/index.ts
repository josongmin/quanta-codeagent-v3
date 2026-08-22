/**
 * explain-stack-trace system skill — public seam for the bundled skill.
 *
 * Sibling of `debug-trace/index.ts` (debugging-trio cluster) and
 * `git-log-search/index.ts` (ADR-0172). The body lives in
 * `explain-stack-trace/SKILL.md`: pure read-only narrative trace explainer
 * (parses via `parse_test_failure`, walks bottom-up, renders ONE paragraph,
 * proposes NO fix — distinct from `debug-trace`).
 *
 * Research grounding: Cursor's CTK demonstrates that narrative / framing
 * tasks (`pr-review-canvas` reviewer walkthrough, `make-pr-easy-to-review`
 * reviewability framing) live in skills because the output is prose shaped
 * by the user's evolving question, not a fixed structured payload
 * (`docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧). A trace
 * explainer is the same shape.
 *
 * An external slash-command router (`/explain-stack-trace`), planner UI
 * button, or IDE shortcut imports {@link EXPLAIN_STACK_TRACE_SKILL_NAME} +
 * {@link triggerExplainStackTrace} to dispatch through the existing `Skill`
 * tool without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `explain-stack-trace/SKILL.md` frontmatter
 *  `name:`. Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-trio-hellgate.test.ts`. */
export const EXPLAIN_STACK_TRACE_SKILL_NAME = "explain-stack-trace" as const

/** Input shape an external router passes when wiring "/explain-stack-trace".
 *  The literal `name` type narrows so a typo is a compile error. */
export interface ExplainStackTraceTrigger {
  readonly name: typeof EXPLAIN_STACK_TRACE_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerExplainStackTrace = (): ExplainStackTraceTrigger => ({
  name: EXPLAIN_STACK_TRACE_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `explain-stack-trace`, or `undefined` if the SKILL.md is missing. */
export const findExplainStackTraceSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === EXPLAIN_STACK_TRACE_SKILL_NAME)

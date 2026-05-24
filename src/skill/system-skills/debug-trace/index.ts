/**
 * debug-trace system skill — public seam for the bundled skill.
 *
 * Sibling of `git-log-search/index.ts` (ADR-0172) and `debug-error/index.ts`
 * (ADR-0134); mirrors the progress-audit / CTK shape exactly. The body lives
 * in `debug-trace/SKILL.md`: orchestrates the four-step crash-investigation
 * workflow (collect → parse via `parse_test_failure` → read each frame →
 * ranked hypothesis with file:line + one-line cause + one-line fix).
 *
 * Research grounding: Cursor exposes per-action tools (`gh pr checks`,
 * `blame_by_file_path`) but workflow-shaped tasks (`fix-merge-conflicts`,
 * `loop-on-ci`) live in CTK skills because they orchestrate several tools
 * through a decision tree the user iterates on
 * (`docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧). Crash
 * investigation is the same shape — this file is the router-agnostic seam.
 *
 * An external slash-command router (`/debug-trace`), planner UI button, or
 * IDE shortcut imports {@link DEBUG_TRACE_SKILL_NAME} +
 * {@link triggerDebugTrace} to dispatch through the existing `Skill` tool
 * without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `debug-trace/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-trio-hellgate.test.ts`. */
export const DEBUG_TRACE_SKILL_NAME = "debug-trace" as const

/** Input shape an external router passes when wiring "/debug-trace". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface DebugTraceTrigger {
  readonly name: typeof DEBUG_TRACE_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerDebugTrace = (): DebugTraceTrigger => ({
  name: DEBUG_TRACE_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `debug-trace`, or `undefined` if the SKILL.md is missing. */
export const findDebugTraceSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === DEBUG_TRACE_SKILL_NAME)

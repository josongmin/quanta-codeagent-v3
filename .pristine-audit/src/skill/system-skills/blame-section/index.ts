/**
 * blame-section system skill — public seam for the bundled skill.
 *
 * Sibling of `git-log-search/index.ts` (ADR-0172) and the CTK git-skill
 * bundle (ADR-0111). The body lives in `blame-section/SKILL.md`: wraps the
 * existing `git_blame_heatmap` tool (ADR-0096 range form via `start_line`/
 * `end_line`) with a workflow that groups by author + commit, surfaces the
 * top-3 authors with line counts, cites ≥2 specific commit SHAs (most-
 * touched + most-recent), and distinguishes ORIGINAL author (pickaxe via
 * `git log -S` / `-L:funcname:file`) vs RECENT editor (the default `git
 * blame` answer).
 *
 * Research grounding: Cursor exposes `blame_by_file_path` as the atomic
 * ownership tool, but ownership-narrative workflows live in CTK skills
 * (`pr-review-canvas` reviewer-assignment framing, `make-pr-easy-to-review`
 * moved-code attribution) — see
 * `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧. Section
 * ownership is the same workflow shape.
 *
 * An external slash-command router (`/blame-section`), planner UI button,
 * or IDE shortcut imports {@link BLAME_SECTION_SKILL_NAME} +
 * {@link triggerBlameSection} to dispatch through the existing `Skill` tool
 * without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `blame-section/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-trio-hellgate.test.ts`. */
export const BLAME_SECTION_SKILL_NAME = "blame-section" as const

/** Input shape an external router passes when wiring "/blame-section". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface BlameSectionTrigger {
  readonly name: typeof BLAME_SECTION_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerBlameSection = (): BlameSectionTrigger => ({
  name: BLAME_SECTION_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `blame-section`, or `undefined` if the SKILL.md is missing. */
export const findBlameSectionSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === BLAME_SECTION_SKILL_NAME)

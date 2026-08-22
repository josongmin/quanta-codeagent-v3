/**
 * New-branch-and-pr CTK git skill — public seam for slash-command router
 * wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `new-branch-and-pr/SKILL.md` frontmatter
 * `name:`. Drift is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const NEW_BRANCH_AND_PR_SKILL_NAME = "new-branch-and-pr" as const

/**
 * Input shape an external router passes when wiring "/new-branch-and-pr".
 * The literal `name` type narrows so a typo is a compile error.
 */
export interface NewBranchAndPrTrigger {
  readonly name: typeof NEW_BRANCH_AND_PR_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerNewBranchAndPr = (): NewBranchAndPrTrigger => ({
  name: NEW_BRANCH_AND_PR_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `new-branch-and-pr`, or `undefined` if the SKILL.md is missing.
 */
export const findNewBranchAndPrSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === NEW_BRANCH_AND_PR_SKILL_NAME)

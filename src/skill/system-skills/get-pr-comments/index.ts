/**
 * Get-pr-comments CTK git skill — public seam for slash-command router
 * wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `get-pr-comments/SKILL.md` frontmatter
 * `name:`. Drift is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const GET_PR_COMMENTS_SKILL_NAME = "get-pr-comments" as const

/**
 * Input shape an external router passes when wiring "/get-pr-comments".
 * The literal `name` type narrows so a typo is a compile error.
 */
export interface GetPrCommentsTrigger {
  readonly name: typeof GET_PR_COMMENTS_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerGetPrComments = (): GetPrCommentsTrigger => ({
  name: GET_PR_COMMENTS_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `get-pr-comments`, or `undefined` if the SKILL.md is missing.
 */
export const findGetPrCommentsSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === GET_PR_COMMENTS_SKILL_NAME)

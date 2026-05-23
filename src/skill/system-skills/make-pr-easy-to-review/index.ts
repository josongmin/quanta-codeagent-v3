/**
 * Make-pr-easy-to-review CTK git skill — public seam for slash-command
 * router wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `make-pr-easy-to-review/SKILL.md`
 * frontmatter `name:`. Drift is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const MAKE_PR_EASY_TO_REVIEW_SKILL_NAME = "make-pr-easy-to-review" as const

/**
 * Input shape an external router passes when wiring
 * "/make-pr-easy-to-review". The literal `name` type narrows so a typo is
 * a compile error.
 */
export interface MakePrEasyToReviewTrigger {
  readonly name: typeof MAKE_PR_EASY_TO_REVIEW_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerMakePrEasyToReview = (): MakePrEasyToReviewTrigger => ({
  name: MAKE_PR_EASY_TO_REVIEW_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `make-pr-easy-to-review`, or `undefined` if the SKILL.md is missing.
 */
export const findMakePrEasyToReviewSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === MAKE_PR_EASY_TO_REVIEW_SKILL_NAME)

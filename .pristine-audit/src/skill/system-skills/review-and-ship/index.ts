/**
 * Review-and-ship CTK git skill — public seam for slash-command router
 * wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `review-and-ship/SKILL.md` frontmatter
 * `name:`. Drift is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const REVIEW_AND_SHIP_SKILL_NAME = "review-and-ship" as const

/**
 * Input shape an external router passes when wiring "/review-and-ship".
 * The literal `name` type narrows so a typo is a compile error.
 */
export interface ReviewAndShipTrigger {
  readonly name: typeof REVIEW_AND_SHIP_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerReviewAndShip = (): ReviewAndShipTrigger => ({
  name: REVIEW_AND_SHIP_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `review-and-ship`, or `undefined` if the SKILL.md is missing.
 */
export const findReviewAndShipSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === REVIEW_AND_SHIP_SKILL_NAME)

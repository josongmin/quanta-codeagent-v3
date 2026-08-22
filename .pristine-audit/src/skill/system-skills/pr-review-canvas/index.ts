/**
 * Pr-review-canvas CTK git skill — public seam for slash-command router
 * wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `pr-review-canvas/SKILL.md` frontmatter
 * `name:`. Drift is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const PR_REVIEW_CANVAS_SKILL_NAME = "pr-review-canvas" as const

/**
 * Input shape an external router passes when wiring "/pr-review-canvas".
 * The literal `name` type narrows so a typo is a compile error.
 */
export interface PrReviewCanvasTrigger {
  readonly name: typeof PR_REVIEW_CANVAS_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerPrReviewCanvas = (): PrReviewCanvasTrigger => ({
  name: PR_REVIEW_CANVAS_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `pr-review-canvas`, or `undefined` if the SKILL.md is missing.
 */
export const findPrReviewCanvasSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === PR_REVIEW_CANVAS_SKILL_NAME)

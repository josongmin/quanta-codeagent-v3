/**
 * pr-review-canvas CTK skill — public seam (ADR-0102 absorption batch).
 *
 * The killer-feature skill: moved-code detection separates function relocations
 * from real logic changes. See `src/tool/git/moved-code/` (ADR-0109) for the
 * algorithm and `pr-review-canvas/SKILL.md` for the prompt blueprint.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const PR_REVIEW_CANVAS_SKILL_NAME = "pr-review-canvas" as const

export interface PrReviewCanvasTrigger {
  readonly name: typeof PR_REVIEW_CANVAS_SKILL_NAME
}

export const triggerPrReviewCanvas = (): PrReviewCanvasTrigger => ({
  name: PR_REVIEW_CANVAS_SKILL_NAME,
})

export const findPrReviewCanvasSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === PR_REVIEW_CANVAS_SKILL_NAME)

/**
 * make-pr-easy-to-review CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const MAKE_PR_EASY_TO_REVIEW_SKILL_NAME = "make-pr-easy-to-review" as const

export interface MakePrEasyToReviewTrigger {
  readonly name: typeof MAKE_PR_EASY_TO_REVIEW_SKILL_NAME
}

export const triggerMakePrEasyToReview = (): MakePrEasyToReviewTrigger => ({
  name: MAKE_PR_EASY_TO_REVIEW_SKILL_NAME,
})

export const findMakePrEasyToReviewSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === MAKE_PR_EASY_TO_REVIEW_SKILL_NAME)

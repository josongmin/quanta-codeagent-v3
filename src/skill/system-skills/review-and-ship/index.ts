/**
 * review-and-ship CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const REVIEW_AND_SHIP_SKILL_NAME = "review-and-ship" as const

export interface ReviewAndShipTrigger {
  readonly name: typeof REVIEW_AND_SHIP_SKILL_NAME
}

export const triggerReviewAndShip = (): ReviewAndShipTrigger => ({
  name: REVIEW_AND_SHIP_SKILL_NAME,
})

export const findReviewAndShipSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === REVIEW_AND_SHIP_SKILL_NAME)

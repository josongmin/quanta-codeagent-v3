/**
 * get-pr-comments CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const GET_PR_COMMENTS_SKILL_NAME = "get-pr-comments" as const

export interface GetPrCommentsTrigger {
  readonly name: typeof GET_PR_COMMENTS_SKILL_NAME
}

export const triggerGetPrComments = (): GetPrCommentsTrigger => ({
  name: GET_PR_COMMENTS_SKILL_NAME,
})

export const findGetPrCommentsSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === GET_PR_COMMENTS_SKILL_NAME)

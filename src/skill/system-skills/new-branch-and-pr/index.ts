/**
 * new-branch-and-pr CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const NEW_BRANCH_AND_PR_SKILL_NAME = "new-branch-and-pr" as const

export interface NewBranchAndPrTrigger {
  readonly name: typeof NEW_BRANCH_AND_PR_SKILL_NAME
}

export const triggerNewBranchAndPr = (): NewBranchAndPrTrigger => ({
  name: NEW_BRANCH_AND_PR_SKILL_NAME,
})

export const findNewBranchAndPrSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === NEW_BRANCH_AND_PR_SKILL_NAME)

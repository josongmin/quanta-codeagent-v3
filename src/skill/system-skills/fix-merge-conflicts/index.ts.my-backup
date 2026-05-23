/**
 * fix-merge-conflicts CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const FIX_MERGE_CONFLICTS_SKILL_NAME = "fix-merge-conflicts" as const

export interface FixMergeConflictsTrigger {
  readonly name: typeof FIX_MERGE_CONFLICTS_SKILL_NAME
}

export const triggerFixMergeConflicts = (): FixMergeConflictsTrigger => ({
  name: FIX_MERGE_CONFLICTS_SKILL_NAME,
})

export const findFixMergeConflictsSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === FIX_MERGE_CONFLICTS_SKILL_NAME)

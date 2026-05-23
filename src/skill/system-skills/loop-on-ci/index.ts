/**
 * loop-on-ci CTK skill — public seam (ADR-0102 absorption batch).
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

export const LOOP_ON_CI_SKILL_NAME = "loop-on-ci" as const

export interface LoopOnCiTrigger {
  readonly name: typeof LOOP_ON_CI_SKILL_NAME
}

export const triggerLoopOnCi = (): LoopOnCiTrigger => ({
  name: LOOP_ON_CI_SKILL_NAME,
})

export const findLoopOnCiSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === LOOP_ON_CI_SKILL_NAME)

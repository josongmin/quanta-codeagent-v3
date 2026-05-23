/**
 * babysit CTK skill — public seam (ADR-0102 absorption batch).
 *
 * Pattern mirrors `progress-audit/index.ts`: NAME constant + Trigger
 * interface + triggerXxx() factory + findXxxSkill() accessor. A future
 * slash-command router imports these instead of hardcoding the string id.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id — mirrors the `name:` field in `babysit/SKILL.md` (SSOT). */
export const BABYSIT_SKILL_NAME = "babysit" as const

/** Skill-tool input shape. The literal `name` type narrows to the skill id
 *  so a typo at the router boundary is a compile error. */
export interface BabysitTrigger {
  readonly name: typeof BABYSIT_SKILL_NAME
}

/** Router-agnostic wiring seam. Returns the `Skill` tool input that
 *  activates babysit. Pure: zero IO, byte-stable across calls. */
export const triggerBabysit = (): BabysitTrigger => ({
  name: BABYSIT_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  babysit, or `undefined` if the bundled SKILL.md is missing. */
export const findBabysitSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === BABYSIT_SKILL_NAME)

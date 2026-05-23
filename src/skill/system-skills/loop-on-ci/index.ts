/**
 * Loop-on-ci CTK git skill — public seam for slash-command router wiring
 * (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `loop-on-ci/SKILL.md` frontmatter `name:`.
 * Drift is caught by `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const LOOP_ON_CI_SKILL_NAME = "loop-on-ci" as const

/**
 * Input shape an external router passes when wiring "/loop-on-ci". The
 * literal `name` type narrows so a typo is a compile error.
 */
export interface LoopOnCiTrigger {
  readonly name: typeof LOOP_ON_CI_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerLoopOnCi = (): LoopOnCiTrigger => ({
  name: LOOP_ON_CI_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `loop-on-ci`, or `undefined` if the SKILL.md is missing.
 */
export const findLoopOnCiSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === LOOP_ON_CI_SKILL_NAME)

/**
 * add-tests system skill (ADR-0134) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` and the
 * CTK skills (`babysit/index.ts` et al). The body lives in
 * `add-tests/SKILL.md`: a 5-rule evidence-first decision tree for
 * authoring new tests against an existing module.
 *
 * An external slash-command router (`/add-tests`), planner UI button, or
 * IDE shortcut imports {@link ADD_TESTS_SKILL_NAME} +
 * {@link triggerAddTests} to dispatch through the existing `Skill` tool
 * without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `add-tests/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-bundle-hellgate.test.ts`. */
export const ADD_TESTS_SKILL_NAME = "add-tests" as const

/** Input shape an external router passes when wiring "/add-tests". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface AddTestsTrigger {
  readonly name: typeof ADD_TESTS_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerAddTests = (): AddTestsTrigger => ({
  name: ADD_TESTS_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `add-tests`, or `undefined` if the SKILL.md is missing. */
export const findAddTestsSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === ADD_TESTS_SKILL_NAME)

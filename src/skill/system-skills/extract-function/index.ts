/**
 * extract-function system skill (ADR-0134) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` and the
 * CTK skills (`babysit/index.ts` et al). The body lives in
 * `extract-function/SKILL.md`: a 5-rule caller-aware decision tree for
 * extracting a code block into a named function without regression.
 *
 * An external slash-command router (`/extract-function`), planner UI
 * button, or IDE shortcut imports {@link EXTRACT_FUNCTION_SKILL_NAME} +
 * {@link triggerExtractFunction} to dispatch through the existing `Skill`
 * tool without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `extract-function/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-bundle-hellgate.test.ts`. */
export const EXTRACT_FUNCTION_SKILL_NAME = "extract-function" as const

/** Input shape an external router passes when wiring "/extract-function".
 *  The literal `name` type narrows so a typo is a compile error. */
export interface ExtractFunctionTrigger {
  readonly name: typeof EXTRACT_FUNCTION_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerExtractFunction = (): ExtractFunctionTrigger => ({
  name: EXTRACT_FUNCTION_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `extract-function`, or `undefined` if the SKILL.md is missing. */
export const findExtractFunctionSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === EXTRACT_FUNCTION_SKILL_NAME)

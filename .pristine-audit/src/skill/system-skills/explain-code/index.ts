/**
 * explain-code system skill (ADR-0134) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` and the
 * CTK skills (`babysit/index.ts` et al). The body lives in
 * `explain-code/SKILL.md`: a 5-rule read-first decision tree for
 * explaining functions / modules / files with caller and history context.
 *
 * An external slash-command router (`/explain-code`), planner UI button,
 * or IDE shortcut imports {@link EXPLAIN_CODE_SKILL_NAME} +
 * {@link triggerExplainCode} to dispatch through the existing `Skill`
 * tool without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `explain-code/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-bundle-hellgate.test.ts`. */
export const EXPLAIN_CODE_SKILL_NAME = "explain-code" as const

/** Input shape an external router passes when wiring "/explain-code". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface ExplainCodeTrigger {
  readonly name: typeof EXPLAIN_CODE_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerExplainCode = (): ExplainCodeTrigger => ({
  name: EXPLAIN_CODE_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `explain-code`, or `undefined` if the SKILL.md is missing. */
export const findExplainCodeSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === EXPLAIN_CODE_SKILL_NAME)

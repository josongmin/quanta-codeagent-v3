/**
 * debug-error system skill (ADR-0134) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` and the
 * CTK skills (`babysit/index.ts` et al). The body lives in
 * `debug-error/SKILL.md`: a 5-rule evidence-first decision tree for
 * diagnosing failing tests, exceptions, and red CI logs.
 *
 * An external slash-command router (`/debug-error`), planner UI button, or
 * IDE shortcut imports {@link DEBUG_ERROR_SKILL_NAME} +
 * {@link triggerDebugError} to dispatch through the existing `Skill` tool
 * without re-implementing skill plumbing.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `debug-error/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-new-bundle-hellgate.test.ts`. */
export const DEBUG_ERROR_SKILL_NAME = "debug-error" as const

/** Input shape an external router passes when wiring "/debug-error". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface DebugErrorTrigger {
  readonly name: typeof DEBUG_ERROR_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerDebugError = (): DebugErrorTrigger => ({
  name: DEBUG_ERROR_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `debug-error`, or `undefined` if the SKILL.md is missing. */
export const findDebugErrorSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === DEBUG_ERROR_SKILL_NAME)

/**
 * Rewind system skill (ADR-0122) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` and the
 * CTK skills (`fix-merge-conflicts/index.ts` et al). The slash-command
 * router (`/rewind`) imports {@link REWIND_SKILL_NAME} +
 * {@link triggerRewind} to dispatch through the existing `Skill` tool
 * without re-implementing skill plumbing.
 *
 * The skill itself ties together three shadow tools (`shadow_snapshots`,
 * `shadow_rewind`, `shadow_restore_partial`) into a single decision tree
 * — see `rewind/SKILL.md` for the body.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `rewind/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/shadow-odb-rewind-extensions-hellgate.test.ts`. */
export const REWIND_SKILL_NAME = "rewind" as const

/** Input shape an external router passes when wiring "/rewind". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface RewindTrigger {
  readonly name: typeof REWIND_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerRewind = (): RewindTrigger => ({
  name: REWIND_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `rewind`, or `undefined` if the SKILL.md is missing. */
export const findRewindSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === REWIND_SKILL_NAME)

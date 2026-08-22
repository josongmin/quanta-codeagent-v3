/**
 * Fix-merge-conflicts CTK git skill — public seam for slash-command
 * router wiring (ADR-0102 Phase AS absorption batch).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`. See
 * `babysit/index.ts` for the full rationale.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `fix-merge-conflicts/SKILL.md` frontmatter
 * `name:`. Drift between this constant and the SKILL.md is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const FIX_MERGE_CONFLICTS_SKILL_NAME = "fix-merge-conflicts" as const

/**
 * Input shape an external router passes when wiring "/fix-merge-conflicts".
 * The literal `name` type narrows so a typo is a compile error.
 */
export interface FixMergeConflictsTrigger {
  readonly name: typeof FIX_MERGE_CONFLICTS_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 */
export const triggerFixMergeConflicts = (): FixMergeConflictsTrigger => ({
  name: FIX_MERGE_CONFLICTS_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `fix-merge-conflicts`, or `undefined` if the SKILL.md is missing.
 */
export const findFixMergeConflictsSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === FIX_MERGE_CONFLICTS_SKILL_NAME)

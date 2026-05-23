/**
 * Babysit CTK git skill — public seam for slash-command router wiring
 * (ADR-0102 Phase AS absorption batch, follow-up to progress-audit /
 * localize-fault pattern).
 *
 * Mirrors the seam shape established in `progress-audit/index.ts` so a
 * future `/babysit` slash command — wherever it ends up living
 * (`src/apps/cli/slash-commands.ts`, an IDE plugin, a planner UI) — can
 * import a typed entry point without reaching into the SKILL.md
 * directory layout or hardcoding the skill id.
 *
 * Two artifacts:
 *   1. {@link BABYSIT_SKILL_NAME} — the canonical skill id ("babysit"),
 *      mirroring the `name:` field in `babysit/SKILL.md` (which is the
 *      SSOT). A rename is a one-line change here + the SKILL.md.
 *   2. {@link triggerBabysit} — returns the `Skill` tool input
 *      (`{ name: "babysit" }`) the LLM-facing dispatch path expects.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors `babysit/SKILL.md` frontmatter `name:`.
 * Drift between this constant and the SKILL.md is caught by
 * `tests/unit/ctk-git-skills-router-hellgate.test.ts`.
 */
export const BABYSIT_SKILL_NAME = "babysit" as const

/**
 * Input shape an external router passes when wiring "/babysit". The
 * literal `name` type narrows to the skill id so a typo at the router
 * boundary is a compile error, not a silent fallthrough.
 */
export interface BabysitTrigger {
  readonly name: typeof BABYSIT_SKILL_NAME
}

/**
 * Router-agnostic wiring seam — pure, zero IO, byte-stable across calls.
 * Returns the `Skill` tool input that activates `babysit`.
 */
export const triggerBabysit = (): BabysitTrigger => ({
  name: BABYSIT_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `babysit`, or `undefined` if the bundled SKILL.md is missing
 * (corrupt install / partial bundle).
 */
export const findBabysitSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === BABYSIT_SKILL_NAME)

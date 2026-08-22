/**
 * Localize-fault system skill — public seam for the bundled 3-stage fault
 * localization skill. Mirrors the `progress-audit` wiring shape so external
 * routers (`/localize`, planner UI, SWE-bench harness) reference one canonical
 * id and one router-agnostic trigger helper instead of hardcoding strings.
 *
 * The skill body (`localize-fault/SKILL.md`) encodes the Agentless
 * file→function→edit-location funnel + Codex signal-trust hierarchy. This
 * module is the dispatch-layer SSOT for "what `/localize` activates".
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors the `name:` field in `localize-fault/SKILL.md`
 *  (SSOT). Importers MUST NOT hardcode the literal — drift between this
 *  constant and the SKILL.md is caught by the discovery unit test. */
export const LOCALIZE_FAULT_SKILL_NAME = "localize-fault" as const

/** Input shape a router passes to activate localize-fault. Mirrors the `Skill`
 *  tool's `inputSchema`; the literal `name` narrows so a typo at the router
 *  boundary is a compile error. */
export interface LocalizeFaultTrigger {
  readonly name: typeof LOCALIZE_FAULT_SKILL_NAME
}

/** Router-agnostic wiring seam. Returns the `Skill` tool input that arms the
 *  localize-fault funnel. A future `/localize` slash command feeds this result
 *  straight to the `Skill` tool dispatch path. Pure: zero IO, byte-stable. */
export const triggerLocalizeFault = (): LocalizeFaultTrigger => ({
  name: LOCALIZE_FAULT_SKILL_NAME,
})

/** Convenience accessor: the discovered `Skill` record for `localize-fault`,
 *  or `undefined` if the bundled SKILL.md is missing (corrupt/partial bundle).
 *  Body included (progressive disclosure defers model-context loading, not
 *  filesystem reads). */
export const findLocalizeFaultSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === LOCALIZE_FAULT_SKILL_NAME)

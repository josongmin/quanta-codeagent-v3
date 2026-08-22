/**
 * Progress-audit system skill (ADR-0045) — public seam for the bundled skill.
 *
 * Two things live here:
 *
 *   1. {@link PROGRESS_AUDIT_SKILL_NAME} — the canonical skill id ("progress-
 *      audit"). Importing this constant instead of hardcoding the string
 *      makes a rename a one-line change reviewable by a non-author, and lets
 *      external slash-command routers reference the same id the SKILL.md
 *      frontmatter declares.
 *
 *   2. {@link triggerProgressAudit} — a host-callable helper that returns the
 *      arguments an LLM-facing `Skill` tool invocation MUST carry to arm the
 *      progress-audit gate (`{ name: "progress-audit" }`). This is the
 *      router-agnostic seam an external slash router (`/progress-audit`,
 *      planner UI button, voice-shortcut, ...) calls when it wants to
 *      promote a one-shot user command into the underlying skill activation
 *      without re-implementing skill plumbing (ADR-0045 §한계 (c)).
 *
 * Why a separate helper (Option 2 from ADR-0045 §wiring): the v3 codebase
 * does not yet have a centralised slash-command router (`src/apps/cli/slash-
 * commands.ts` is unimplemented in main). Exposing a typed function from the
 * skill module lets a future router import it without the router and the
 * skill drifting in lockstep — the function is the SSOT for what
 * "/progress-audit" actually does at the dispatch layer.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/**
 * Canonical skill id. Mirrors the `name:` field in
 * `progress-audit/SKILL.md` (which is the SSOT). Importers MUST NOT
 * hardcode the literal string — drift between the constant and the
 * SKILL.md is caught by `tests/unit/skill-progress-audit.test.ts`.
 */
export const PROGRESS_AUDIT_SKILL_NAME = "progress-audit" as const

/**
 * Input shape an external router passes when wiring "/progress-audit".
 * Mirrors `Skill` tool's `inputSchema` so a router can hand the result
 * straight to dispatch without reshaping. The literal `name` type narrows
 * to the skill id so a typo at the router boundary is a compile error.
 */
export interface ProgressAuditTrigger {
  readonly name: typeof PROGRESS_AUDIT_SKILL_NAME
}

/**
 * Router-agnostic wiring seam (ADR-0045 §한계 (c) follow-up).
 *
 * Returns the `Skill` tool input that activates progress-audit. A future
 * `/progress-audit` slash command — wherever it ends up living
 * (`src/apps/cli/slash-commands.ts`, an IDE plugin, a planner UI) — calls
 * this and feeds the result to the existing `Skill` tool dispatch path.
 *
 * Pure: zero IO, zero side-effects, byte-stable across calls.
 *
 * @example
 *   // External slash router (illustrative — not implemented here):
 *   router.register("/progress-audit", async () => {
 *     const args = triggerProgressAudit()
 *     await tools.get("Skill").execute(args, ctx)
 *   })
 */
export const triggerProgressAudit = (): ProgressAuditTrigger => ({
  name: PROGRESS_AUDIT_SKILL_NAME,
})

/**
 * Convenience accessor: returns the discovered `Skill` record for
 * `progress-audit`, or `undefined` if the bundled SKILL.md is missing
 * (corrupt install / partial bundle). Equivalent to
 * `(await discoverSystemSkills()).find(s => s.name === PROGRESS_AUDIT_SKILL_NAME)`
 * but importing this stops external callers from depending on the array
 * shape.
 *
 * The Skill BODY is included (progressive disclosure does NOT defer
 * filesystem reads — only model-context loading); callers that need the
 * body for prompt injection (e.g. a planner UI preview) can use this
 * without re-implementing the discovery layout.
 */
export const findProgressAuditSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === PROGRESS_AUDIT_SKILL_NAME)

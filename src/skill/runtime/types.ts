/**
 * RFC-06 F1 — live skill runtime authority contracts (`@/skill/runtime`).
 *
 * The canonical runtime authority replaces the older "snapshot filter" idea
 * (README DROP: "frozen-map filter 금지" — the runtime authority is LIVE, not a
 * one-shot snapshot filter). One atomic authority owns the registry, the admin
 * policy, the durable user-disabled set, and a single UNIFIED revision. Every
 * consumer reads a projection off THAT authority at use time:
 *
 *   - prompt inventory / visible tools / CLI+web active readouts read `active`;
 *   - ToolSearch reads `searchable`;
 *   - management views read `management`, which RETAINS disabled rows and their
 *     effective reason.
 *
 * The three projections are derived ATOMICALLY from one registry/policy/disabled
 * revision (see {@link ./projections}), so a persisted disable makes all three
 * consistent at the same revision — a consumer can never filter independently and
 * diverge (the jul-15 "badge shows Disabled but tool still discoverable" trust
 * lie).
 *
 * Slice rules: `@/skill` siblings + `@/shared` only (leaf). No `@/agent`,
 * `@/storage`, host references. exactOptionalPropertyTypes: optional fields are
 * `x?: T | undefined` and are OMITTED when absent.
 */

import type { SkillRegistryEntry } from "../registry"
import type { Skill, SkillInstallState, SkillScope } from "../types"

/**
 * Why a skill is disabled in the management projection. ONLY production-backed
 * sources (RFC-06 D4: the 3 phantom project/session/device layers are DROPPED —
 * fabricating a reason string with no real source is a trust lie). Admin is
 * supreme over user (R3): `administrator` outranks `user`.
 */
export type SkillDisableReason = "administrator" | "user"

/** All disable-reason literals — single source of truth for drift guards. */
export const SKILL_DISABLE_REASONS: readonly SkillDisableReason[] = [
  "administrator",
  "user",
] as const

/**
 * One management row. Present for EVERY registry winner — a disabled skill is
 * retained here (with `enabled: false` + its effective `disableReason`) so the UI
 * can render the "Disabled" badge and offer re-enable. `active`/`searchable`
 * exclude the same row; `management` never does.
 */
export interface ManagedSkill {
  /** Canonical skill name (registry winner). */
  readonly name: string
  /** Winning scope (mirror of the registry entry's `winnerScope`). */
  readonly scope: SkillScope
  /** Frontmatter description (empty string when the skill declares none). */
  readonly description: string
  /** ADR-0134 install posture, when the winning skill declares one. */
  readonly installState?: SkillInstallState | undefined
  /** Effective enabled state at the current revision. */
  readonly enabled: boolean
  /** Effective reason a disabled row is disabled. OMITTED when `enabled`. */
  readonly disableReason?: SkillDisableReason | undefined
}

/**
 * An immutable projection triple at ONE unified revision. The three arms are
 * derived atomically from the same registry/policy/disabled inputs, so they are
 * always mutually consistent: a name absent from `active` for a disable reason is
 * also absent from `searchable`, and present in `management` with that reason.
 */
export interface SkillRuntimeView {
  /** The unified registry+policy+disabled revision. Monotonic; bumps once per
   *  committed {@link SkillRuntimeAuthority.setEnabled}. */
  readonly revision: number
  /** Precedence-resolved winners that are effectively enabled, sorted by name
   *  (the invocable / prompt / active-readout surface). */
  readonly active: readonly Skill[]
  /** Registry entries whose winner is effectively enabled (the ToolSearch
   *  `catalog:"skills"` surface). Never diverges from {@link active}. */
  readonly searchable: readonly SkillRegistryEntry[]
  /** Every registry winner, disabled rows RETAINED with reason. */
  readonly management: readonly ManagedSkill[]
}

/**
 * One entry in the per-turn active-skill INVENTORY (the prompt "## Active skills"
 * reminder surface). Plain `{name, description}` (+ optional lifted
 * `rawDependencies` when the MCP-deps gate is on) so the agent prompt slice never
 * imports a `@/skill` value type — the same shape the prompt already consumed as
 * a frozen array, now read LIVE per turn.
 */
export interface SkillActiveInventoryEntry {
  readonly name: string
  readonly description: string
  /** ADR-0476 — lifted `dependencies` block, propagated ONLY when the
   *  `QUANTA_SKILL_MCP_DEPS` gate is on AND the skill declared one. Omitted
   *  otherwise ⇒ byte-identical inventory shape. */
  readonly rawDependencies?: unknown
}

/**
 * RFC-06 F3 — the NARROW live read view every per-turn discovery consumer holds
 * INSTEAD of a construction-time copy. `SessionFeatures` carries one of these
 * (not a copied `activeSkills` array, not a frozen search catalogue), and the
 * turn loop re-reads it EVERY turn, so a skill disabled after session start
 * disappears from the prompt inventory and ToolSearch on the next request.
 *
 * Backed by the live {@link SkillRuntimeAuthority}: every method reads the
 * CURRENT published {@link SkillRuntimeView}, never a captured snapshot. It is a
 * read-only projection — mutation stays behind the authority's `setEnabled`.
 */
export interface SkillRuntimeReader {
  /** The active-skill inventory for THIS turn's prompt reminder, at the current
   *  revision. Applies the session's `paths:` conditional-activation filter and
   *  the MCP-deps gate on each call over the LIVE active projection. */
  activeInventory(): SkillActiveInventoryEntry[]
  /** The searchable registry-entry projection at the current revision — what
   *  `ToolSearch`'s `catalog:"skills"` mode reads at execution time. */
  searchable(): readonly SkillRegistryEntry[]
  /** The current unified revision (drift/observability; never mutates). */
  revision(): number
}

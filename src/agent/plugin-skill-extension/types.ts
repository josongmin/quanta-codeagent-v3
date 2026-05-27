/**
 * ADR-0339 — Plugin-declared skill set extension types.
 *
 * Closed types for the resolver + union primitives that wire a plugin
 * manifest's `skills[]` (ADR-0336) onto the active-skills channel
 * (ADR-0321 / TurnContextInput.activeSkills consumed by ADR-0327
 * `buildTurnContext`).
 *
 * Slice fence:
 *   - depends on `@/skill/registry-readonly` (ADR-0330 read-only port)
 *   - does NOT depend on `@/skill` registry internals, `@/agent/prompt`,
 *     `@/agent/types` (AgentConfig), or the plugin loader. Composition
 *     roots wire those.
 *   - `SkillActivationEventLike` mirrors the shape of
 *     `@/memory/typed-event` `SkillActivationEvent` byte-for-byte so a
 *     composition root can pass `store.append` directly as the `emit`
 *     hook without an adapter. We DELIBERATELY redeclare locally so the
 *     resolver has zero cross-slice imports from `@/memory/typed-event`
 *     (slice fence).
 */

import type { SkillRegistryReadOnly } from "@/skill/registry-readonly"

/**
 * Local mirror of `@/memory/typed-event` `SkillActivationEvent` — same
 * field set + same `kind` discriminator. Kept slice-local so we do not
 * import from `@/memory/typed-event`. A composition root wiring the
 * typed-history store passes `store.append` directly; structural typing
 * makes the two interfaces interchangeable at the call site.
 *
 * Trigger source semantics:
 *   - `"user"`: explicit user gesture (e.g. `/skill foo`).
 *   - `"auto"`: side-effect of another activation — plugin activation
 *      that pulls in declared skills is the prototypical example. This
 *      is the DEFAULT for {@link PluginSkillExtensionConfig.emit}
 *      because the plugin owns the trigger semantics.
 *   - `"system"`: harness-driven (e.g. mode swap or default-skill
 *      provisioning).
 */
export interface SkillActivationEventLike {
  readonly kind: "skill_activation"
  readonly skillId: string
  readonly trigger: "user" | "auto" | "system"
  readonly at: number
  readonly turnId?: string
}

/**
 * Closed config for {@link resolvePluginSkillsForActivation}.
 *
 * - `registry`: required. The read-only descriptor lookup (ADR-0330).
 * - `emit`: optional. Fires once per resolved (registry-hit) skill.
 *   Missing skills (registry-miss) DO NOT emit. The emit hook is NEVER
 *   awaited and any throw it produces is swallowed — the primitive is
 *   NO-THROW end-to-end.
 */
export interface PluginSkillExtensionConfig {
  readonly registry: SkillRegistryReadOnly
  readonly emit?: (event: SkillActivationEventLike) => void
}

/**
 * Resolved descriptor projected onto the active-skills channel. Mirrors
 * the shape consumed by `TurnContextInput.activeSkills` in
 * `@/agent/prompt`. Kept slice-local so we do not pull `@/agent/prompt`
 * into this slice (slice fence).
 */
export interface ActiveSkillDescriptor {
  readonly name: string
  readonly description: string
}

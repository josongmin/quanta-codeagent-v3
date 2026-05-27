/**
 * ADR-0339 — `src/agent/plugin-skill-extension/` barrel.
 *
 * Two pure primitives that wire plugin manifest `skills[]` (ADR-0336)
 * onto the active-skills channel (ADR-0321 / ADR-0327
 * TurnContextInput.activeSkills). Default-OFF: callers that do not
 * import this barrel get byte-identical legacy behaviour — no plugin
 * skill is auto-added to active skills.
 *
 * NOT re-exported from `@/agent`. Composition roots reach the slice via
 * the explicit `@/agent/plugin-skill-extension` path. Stays a leaf so
 * trees that don't host plugins pay zero import-time cost.
 */

export {
  resolvePluginSkillsForActivation,
  unionActiveSkills,
} from "./extender"
export type {
  ActiveSkillDescriptor,
  PluginSkillExtensionConfig,
  SkillActivationEventLike,
} from "./types"

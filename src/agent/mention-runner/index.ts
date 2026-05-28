/**
 * ADR-0330 — `src/agent/mention-runner/` barrel.
 *
 * Production-wire of ADR-0325's `MentionResolverPort`. Skill-only
 * resolver + plugin/app frozen-`null` + composition `createMentionInjector`
 * that returns the `AgentConfig.mentionInjector` (ADR-0327 slot) function
 * value.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`. Callers
 * reach the slice via the explicit `@/agent/mention-runner` path once
 * the AgentConfig wire-up ADR (ADR-0327) lands.
 *
 * Closed surface:
 *   - `createSkillOnlyResolver(skills?)`     — `MentionResolverPort` impl.
 *   - `createMentionInjector(cfg)`           — composes parser+resolver+builder
 *                                              into the per-turn injector fn.
 *   - `buildDefaultMentionResolver(opts)`    — ADR-0422 DRY composite builder
 *                                              (env knobs → file/symbol/skill).
 *   - `SkillRegistryReadOnly`                — read-only registry port type
 *                                              (structurally compatible with
 *                                              `@/skill/registry-readonly`).
 */

export type {
  BuildDefaultMentionResolverOptions,
  MentionEnv,
} from "./default-resolver"
export { buildDefaultMentionResolver } from "./default-resolver"
export { createMentionInjector } from "./runner"
export { createSkillOnlyResolver } from "./skill-resolver"
export type { MentionRunnerConfig, SkillRegistryReadOnly } from "./types"

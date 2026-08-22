/**
 * ADR-0330 — `src/agent/mention-runner/` barrel.
 *
 * Production-wire of ADR-0325's `MentionResolverPort`. Skill-only
 * resolver + plugin/app frozen-`null`, plus the ADR-0422 DRY composite
 * builder (`buildDefaultMentionResolver`) that every surface composes the
 * `AgentConfig.mentionInjector` from (via `installCodexR2Wires`'s
 * `buildMentionInjector`).
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`. Callers
 * reach the slice via the explicit `@/agent/mention-runner` path.
 *
 * Closed surface:
 *   - `createSkillOnlyResolver(skills?)`     — `MentionResolverPort` impl.
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
export { createSkillOnlyResolver } from "./skill-resolver"
export type { SkillRegistryReadOnly } from "./types"

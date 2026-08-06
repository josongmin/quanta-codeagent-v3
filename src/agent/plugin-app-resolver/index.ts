/**
 * ADR-0336 — `src/agent/plugin-app-resolver/` barrel.
 *
 * Closes ADR-0330's negative invariants
 * (`resolvePlugin → null` / `resolveApp → null`) by providing real
 * `MentionResolverPort` impls for the plugin and app kinds. Also
 * exports a composite factory that wires all three kinds (skill +
 * plugin + app) in one call — the production sibling to ADR-0330's
 * `createSkillOnlyResolver`.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`.
 * Callers reach it via the explicit `@/agent/plugin-app-resolver`
 * path from the composition root that wants full mention coverage.
 *
 * Closed surface:
 *   - `createPluginResolver(registry?)`         — plugin sub-resolver.
 *   - `createAppResolver(catalog?)`             — app sub-resolver.
 *   - `createSkillResolver(skills?)`            — skill sub-resolver.
 *   - `createFileResolver(opts)`                — file sub-resolver (ADR-0413).
 *   - `createCompositeMentionResolver(deps)`    — combine all four.
 *   - `CompositeResolverDeps`                   — dependency bag type.
 *   - `FileResolverOptions`                     — file-resolver options (ADR-0413).
 *   - `LocalPluginActivationEvent` /            — LOCAL MOCKS pending
 *     `LocalAppActivationEvent`                   ADR-0335 integration.
 */

export { createAppResolver } from "./app-resolver"
export {
  type CompositeResolverDeps,
  createCompositeMentionResolver,
} from "./composite-resolver"
export { createFileResolver, type FileResolverOptions } from "./file-resolver"
export {
  createFolderResolver,
  DEFAULT_FOLDER_MAX_ENTRIES,
  type FolderResolverOptions,
} from "./folder-resolver"
export {
  createGitResolver,
  DEFAULT_GIT_MAX_BYTES,
  type GitContextProvider,
  type GitResolverOptions,
  type GitSubcommand,
} from "./git-resolver"
export {
  createMcpResolver,
  DEFAULT_MCP_MAX_TOOLS,
  type McpResolverOptions,
  type McpServerListingPort,
  type McpToolInfo,
} from "./mcp-resolver"
export { createPluginResolver } from "./plugin-resolver"
export { createSkillResolver } from "./skill-resolver"
export { createSubagentResolver } from "./subagent-resolver"
export {
  createThreadResolver,
  type ThreadResolverOptions,
  type ThreadSummary,
  type ThreadSummaryPort,
} from "./thread-resolver"
export type {
  LocalAppActivationEvent,
  LocalPluginActivationEvent,
  SkillRegistryReadOnly,
} from "./types"

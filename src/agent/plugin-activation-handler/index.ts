/**
 * ADR-0340 — `src/agent/plugin-activation-handler/` barrel.
 *
 * Closes the dangling ADR-0338 (`launchPluginMcpServers`) + ADR-0339
 * (`resolvePluginSkillsForActivation` + `unionActiveSkills`) primitives
 * by wiring them through a single per-session closure that activates a
 * plugin by id (MCP spawn + skill resolve + event emit).
 *
 * Default-OFF helper primitive: callers reach this slice via the
 * explicit `@/agent/plugin-activation-handler` path. NOT re-exported
 * from `@/agent`. Composition roots opt in by:
 *
 *   1. Building a `PluginRegistryPort` (ADR-0336 in-memory or fs-backed).
 *   2. Optionally building an `McpLauncherPort` +
 *      `createInMemoryPluginMcpRegistry` (ADR-0338).
 *   3. Optionally building a `SkillRegistryReadOnly` (ADR-0330 / ADR-0339).
 *   4. `const handler = createPluginActivationHandler({...})`.
 *   5. Setting `cfg.activatePlugins = (mentions, opts) =>
 *      activatePluginsFromMentions(mentions, handler, opts)` on the
 *      AgentConfig. The loop / surface hook then calls
 *      `cfg.activatePlugins?(mentions, { turnId })` once per turn.
 *
 * On session shutdown the composition root calls
 * `pluginMcpRegistry.shutdownAll()` (ADR-0338) — this slice does NOT
 * own the registry's lifetime.
 *
 * Slice-fence: this module MAY import `@/agent/plugin-discovery`,
 * `@/agent/plugin-mcp-launcher`, `@/agent/plugin-skill-extension`,
 * `@/agent/mention-injection` (types only), `@/skill/plugin-manifest`,
 * `@/skill/registry-readonly`. It MUST NOT import `@/agent/loop`,
 * `@/agent/dispatch`, `@/agent/prompt`, or `@/agent/types`.
 */

export type { AutoWireDeps } from "./auto-wire"
export { autoWirePluginActivation } from "./auto-wire"
export { activatePluginsFromMentions } from "./composite-activation"
export { createPluginActivationHandler } from "./handler"
// ADR-0341 retired the mcp-shape-adapter — PluginManifest.mcpServers is now
// a Record<string, MCPServerSpec> (Codex parity), so the handler iterates
// the manifest directly. The adapter file + its barrel entries were dropped
// in the reconcile commit; no caller imports them.
export type {
  ActivationCallOpts,
  ActivationHandler,
  ActivationHandlerConfig,
  ActivationResult,
  AggregatedActivation,
} from "./types"

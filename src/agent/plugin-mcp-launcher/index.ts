/**
 * ADR-0338 — `src/agent/plugin-mcp-launcher/` barrel.
 *
 * Default-OFF helper primitive: callers reach this slice via the
 * explicit `@/agent/plugin-mcp-launcher` path. Not re-exported from
 * `@/agent`. The composition root opts in by:
 *
 *   1. Building a `McpLauncherPort` (production:
 *      {@link createIsolatedMcpLauncherPort}; tests: in-memory stub).
 *   2. Building a registry ({@link createInMemoryPluginMcpRegistry}).
 *   3. On plugin activation: `await launchPluginMcpServers(manifest, registry, port)`.
 *   4. On session shutdown: `await registry.shutdownAll()`.
 *
 * The wiring of step 3's trigger (a `plugin://name` mention, an admin
 * activation event, etc.) belongs to a follow-up ADR. This slice ships
 * the primitives only.
 *
 * Slice-fence: this module MAY import `@/mcp` + `@/skill/plugin-manifest`
 * + `@/shared`. It MUST NOT import `@/agent/loop`, `@/agent/dispatch`,
 * or any other `@/agent/*` slice (plane-clean / ADR-0190).
 */

export type { IsolatedMcpLauncherPortOpts } from "./isolated-launcher-port"
export { createIsolatedMcpLauncherPort } from "./isolated-launcher-port"
export { composeServerId, launchPluginMcpServers } from "./launcher"
export { createInMemoryPluginMcpRegistry } from "./registry"
export type {
  McpLauncherPort,
  McpLaunchOpts,
  McpServerHandle,
  PluginMcpRegistry,
  PluginMcpServerSpec,
} from "./types"

/**
 * MCP Skybridge — public surface barrel.
 *
 * Phase 1 ships: typed policy + closed `McpSandbox` port + passthrough adapter
 * + Phase 2 stubs (container, microvm) + registry. Real microVM / container
 * adapters land in Phase 2 (separate ADR).
 *
 * Default-OFF: callers that don't reach for skybridge get byte-identical
 * legacy MCP behavior. Wiring is at the @/agent assembly layer, opt-in via
 * policy.profile.
 */

export { containerMcpSandbox } from "./container"
export { microvmMcpSandbox } from "./microvm"
export { passthroughMcpSandbox } from "./passthrough"
export { type McpSandboxRegistryConfig, resolveMcpSandbox } from "./registry"
export {
  type McpSandbox,
  type McpSandboxAvailability,
  type McpSandboxBackend,
  type McpSandboxConfig,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxIpcChannel,
  type McpSandboxPolicy,
  type McpServerSpec,
  type SkybridgeProfile,
  type SkybridgeSpawner,
  type SkybridgeSpawnHandle,
} from "./types"

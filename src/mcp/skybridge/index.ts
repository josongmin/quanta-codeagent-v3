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

export {
  detectNativeAppleVz,
  mapPolicyToNapi as mapPolicyToNapiVz,
  type NapiMcpVmPolicy,
  type NapiVmSpawnResult,
  type NapiVmSpawnSpec,
  type NativeAppleVzBinding,
  type NativeAppleVzConfig,
  nativeAppleVzSandbox,
} from "./applevz-native"
export { appleVzMicroVmSandbox, appleVzVmName, detectAppleVz } from "./applevz-microvm"
export { containerMcpSandbox } from "./container"
export { compileLimaConfig, detectLima, limaMicroVmSandbox, limaVmName } from "./lima-microvm"
export { microvmMcpSandbox } from "./microvm"
export { passthroughMcpSandbox } from "./passthrough"
export {
  type McpSandboxRegistryConfig,
  type ResolveMcpSandboxAsyncConfig,
  resolveMcpSandbox,
  resolveMcpSandboxAsync,
} from "./registry"
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
  type SkybridgeRunner,
  type SkybridgeRunResult,
  type SkybridgeSpawner,
  type SkybridgeSpawnHandle,
} from "./types"

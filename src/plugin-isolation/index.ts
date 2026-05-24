/** Plugin process isolation slice (ADR-0162). Barrel. */
export { createBunSpawner } from "./bun-spawner"
export type { DxtErrorKind, DxtManifest } from "./dxt-loader"
export {
  DxtError,
  DxtManifestSchema,
  launchDxt,
  MAX_DXT_MANIFEST_BYTES,
  validateDxt,
} from "./dxt-loader"
export type { LifecycleOpts, LifecyclePolicy, LifecycleState } from "./lifecycle"
export {
  DEFAULT_LIFECYCLE_POLICY,
  HEARTBEAT_PING_METHOD,
  HEARTBEAT_PONG_METHOD,
  LifecycleError,
  PluginLifecycleManager,
} from "./lifecycle"
export type { CallOpts, PluginHostOpts } from "./plugin-host"
export { DEFAULT_CALL_TIMEOUT_MS, PluginHost, PluginHostError } from "./plugin-host"
export type {
  IsolatedProcess,
  IsolatedProcessSpawnerPort,
  SpawnOpts,
} from "./types"
export {
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
  IsolatedSpawnError,
  MAX_MESSAGE_BYTES,
} from "./types"

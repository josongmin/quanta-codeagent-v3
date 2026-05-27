/**
 * ADR-0345 — `src/agent/session-resource-registry/` barrel.
 *
 * Process-local registry that maps `sessionId → { TypedHistoryEventStore,
 * SystemPromptCachePort }`. Composition roots that adopt the registry
 * gain reuse semantics for repeated `assembleAgentConfig(sessionId)` /
 * `installCodexR2Wires` calls on the SAME id.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`.
 * Composition roots reach the slice via the explicit
 * `@/agent/session-resource-registry` path. Stays a leaf so callers
 * that don't need session-keyed reuse pay zero import-time cost.
 *
 * Closed-port pattern: the default `InMemorySessionResourceRegistry`
 * class is intentionally NOT exported — only the
 * `createInMemorySessionResourceRegistry` factory and the port types.
 * Alternate adapters (disk, distributed) live in sibling files behind
 * a separate ADR.
 */

// ADR-0348 — Disk-persistent adapter (explicit opt-in, sibling slice).
export { createDiskSessionResourceRegistry } from "./disk-adapter/disk-store"
export type { AcquireSessionLockOpts, SessionLock } from "./disk-adapter/file-lock"
// ADR-0356 — Multi-process lockfile (used internally by ADR-0348 +
// optionally consumable by external composition roots that want to
// gate their own per-session ops on the same lock).
export {
  acquireSessionLock,
  DEFAULT_LOCK_RETRY_INTERVAL_MS,
  DEFAULT_LOCK_STALE_THRESHOLD_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_FILENAME,
} from "./disk-adapter/file-lock"
export type { SweepResult } from "./disk-adapter/gc"
export { sweepDiskRegistry } from "./disk-adapter/gc"
export {
  buildPersistedSnapshot,
  deserializeCacheLine,
  deserializeEventLine,
  parseCacheBody,
  parseEventsBody,
  serializeCacheLine,
  serializeEventLine,
} from "./disk-adapter/serializer"
export type {
  CacheLine,
  DiskRegistryConfig,
  EventLine,
  PersistedCacheEntry,
  PersistedSessionResources,
} from "./disk-adapter/types"
export { DEFAULT_MAX_SESSION_BYTES, DEFAULT_TTL_MS } from "./disk-adapter/types"
// ADR-0347 — Process-level singleton wire for composition roots.
export {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "./global"
export { createInMemorySessionResourceRegistry } from "./in-memory-registry"
export type { RegistryConfig, SessionResourceRegistry, SessionResources } from "./types"

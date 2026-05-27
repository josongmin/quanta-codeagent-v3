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

export {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "./global"
export { createInMemorySessionResourceRegistry } from "./in-memory-registry"
export type { RegistryConfig, SessionResourceRegistry, SessionResources } from "./types"

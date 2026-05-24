/**
 * Barrel for Phase 1 SUBAGENT PERSISTENCE (ADR-0158).
 *
 * Re-exports the closed-port type, the typed error class, the persisted
 * handle shape + status union, and the two default factories. Existing
 * `src/agent/subagent-background.ts` is NOT modified — the wrapper is a
 * pure composition layer.
 */

export {
  PersistenceError,
  type PersistedHandle,
  type PersistedSubagentStatus,
  type PersistentSchedulerStore,
} from "./types"
export { defaultJsonlSchedulerStore, type JsonlStoreOpts } from "./jsonl-store"
export {
  type HydratingSchedulerOpts,
  persistentBackgroundSubagentScheduler,
} from "./hydrating-scheduler"

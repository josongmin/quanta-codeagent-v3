/**
 * Barrel for Phase 1 SUBAGENT PERSISTENCE (ADR-0158).
 *
 * Re-exports the closed-port type, the typed error class, the persisted
 * handle shape + status union, and the two default factories. Existing
 * `src/agent/subagent-background.ts` is NOT modified — the wrapper is a
 * pure composition layer.
 */

export {
  type HydratedSubagentResult,
  type HydratedSubagentStatus,
  type HydratingSchedulerOpts,
  type PersistentBackgroundSubagentScheduler,
  persistentBackgroundSubagentScheduler,
} from "./hydrating-scheduler"
export { defaultJsonlSchedulerStore, type JsonlStoreOpts } from "./jsonl-store"
export {
  type PersistedHandle,
  type PersistedSubagentStatus,
  PersistenceError,
  type PersistentSchedulerStore,
} from "./types"

export { InMemoryStore } from "./adapters/in-memory"
export { SqliteStore } from "./adapters/sqlite"
/** ADR-0068 2-phase consolidator surface (Phase 1 = per-thread distill). Wave
 *  D session-end hook in `@/agent` wires `runPhase1` through these ports so
 *  the loop never reaches into `consolidate/*` internals (RFC §3.1 layering). */
export {
  type MemoryOutcome,
  MemoryWriteError,
  MemoryWriter,
  Phase1DistillError,
  type Phase1Input,
  type Phase1Outcome,
  type Phase1Port,
  Phase2ConsolidateError,
  type Phase2Input,
  type Phase2Outcome,
  type Phase2Port,
  type Phase2Summarizer,
  runPhase1,
  runPhase2,
  type Stage1Output,
  Stage1Store,
  type Stage1StorePort,
  WatermarkConflictError,
  type WatermarkState,
} from "./consolidate"
/** Phase-2 consolidated `memory_summary.md` hard byte cap. Re-exported through
 *  the `@/memory` barrel so consumers (e.g. `@/agent/prompt-sections`) need not
 *  reach into the `consolidate/constants` internal path. */
export {
  MEMORY_SUMMARY_MAX_BYTES,
  MIN_TURN_THRESHOLD as MEMORY_CONSOLIDATE_MIN_TURNS,
  PHASE2_AUTO_TRIGGER_MAX_AGE_MS,
  PHASE2_AUTO_TRIGGER_PENDING,
} from "./consolidate/constants"
export {
  DEFAULT_DUPE_THRESHOLDS,
  type DupeThresholds,
  findNearDuplicates,
} from "./dedup"
export {
  DEFAULT_EVICTION_CAPS,
  EVICTION_DECAY,
  type EvictionCaps,
  type EvictionPlan,
  planEviction,
} from "./eviction"
export type { PersistentStorePort } from "./ports"
export { rankEntries, scoreEntry } from "./ranking"
export {
  FORBIDDEN_TELEMETRY_KEYS,
  type MemoryTelemetryPort,
  noopMemoryTelemetry,
  PHASE1_EVENT_ALLOWED_KEYS,
  PHASE2_EVENT_ALLOWED_KEYS,
  type Phase1OutcomeKind,
  type Phase1TelemetryEvent,
  type Phase2OutcomeKind,
  type Phase2TelemetryEvent,
  RECALL_EVENT_ALLOWED_KEYS,
  type RecallTelemetryEvent,
} from "./telemetry-port"
export {
  bucketOf,
  DEFAULT_RECALL_LIMIT,
  EMBED_DIM,
  type EmbedderPort,
  FRESH_MAX_MS,
  type FreshnessBucket,
  MEMORY_KINDS,
  MEMORY_TIERS,
  type MemoryEntry,
  type MemoryKind,
  type MemoryQuery,
  type MemoryTier,
  type NormalizedEntry,
  normalizeEntry,
  RECENT_MAX_MS,
  STALE_MAX_MS,
  type StoredMessage,
} from "./types"
export { cosine, deserializeVec, normalize, serializeVec } from "./vector"
export { createWorkingMemory, type WorkingMemory } from "./working"

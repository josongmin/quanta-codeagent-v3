export { InMemoryStore } from "./adapters/in-memory"
export { SqliteStore } from "./adapters/sqlite"
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

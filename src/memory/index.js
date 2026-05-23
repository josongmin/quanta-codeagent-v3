export { InMemoryStore } from "./adapters/in-memory";
export { SqliteStore } from "./adapters/sqlite";
/** ADR-0068 2-phase consolidator surface (Phase 1 = per-thread distill). Wave
 *  D session-end hook in `@/agent` wires `runPhase1` through these ports so
 *  the loop never reaches into `consolidate/*` internals (RFC §3.1 layering). */
export { Phase1DistillError, runPhase1, Stage1Store, } from "./consolidate";
/** Phase-2 consolidated `memory_summary.md` hard byte cap. Re-exported through
 *  the `@/memory` barrel so consumers (e.g. `@/agent/prompt-sections`) need not
 *  reach into the `consolidate/constants` internal path. */
export { MEMORY_SUMMARY_MAX_BYTES, MIN_TURN_THRESHOLD as MEMORY_CONSOLIDATE_MIN_TURNS, } from "./consolidate/constants";
export { DEFAULT_DUPE_THRESHOLDS, findNearDuplicates, } from "./dedup";
export { DEFAULT_EVICTION_CAPS, EVICTION_DECAY, planEviction, } from "./eviction";
export { rankEntries, scoreEntry } from "./ranking";
export { bucketOf, DEFAULT_RECALL_LIMIT, EMBED_DIM, FRESH_MAX_MS, MEMORY_KINDS, MEMORY_TIERS, normalizeEntry, RECENT_MAX_MS, STALE_MAX_MS, } from "./types";
export { cosine, deserializeVec, normalize, serializeVec } from "./vector";
export { createWorkingMemory } from "./working";

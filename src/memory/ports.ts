import type { MemoryEntry, MemoryQuery } from "./types"

/**
 * Durable long-term memory store (RFC §6.3). Two adapters exist
 * (in-memory, sqlite) → full hexagonal per RFC §5.1. All adapters normalize
 * entries on the boundary ({@link import("./types").normalizeEntry}) and share
 * the ranking layer, so semantics never diverge.
 */
export interface PersistentStorePort {
  /** Persist (or overwrite, by id) a memory entry. */
  save(entry: MemoryEntry): Promise<void>
  /**
   * Shallow-merge a patch into an existing entry by id and bump `updatedAt`.
   * No-op if the id is unknown. Used by reinforcement, consolidation, and the
   * self-edit `memory_update` tool.
   */
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>
  /** Hard-delete an entry by id. No-op if unknown. */
  delete(id: string): Promise<void>
  /** Fetch one entry by id, or `undefined`. */
  get(id: string): Promise<MemoryEntry | undefined>
  /**
   * Every stored entry (including superseded), unranked. For full-store sweeps:
   * eviction and dedup/consolidation. Adapters should keep this lazy/bounded
   * where possible; callers must not assume cheapness.
   */
  all(): Promise<MemoryEntry[]>
  /** Return entries matching the query, best-ranked first (see ranking.ts). */
  recall(query: MemoryQuery): Promise<MemoryEntry[]>
}

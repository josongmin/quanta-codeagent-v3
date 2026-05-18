import type { MemoryEntry, MemoryQuery } from "./types"

/**
 * Durable long-term memory store (RFC §6.3). Two adapters exist
 * (in-memory, sqlite) → full hexagonal per RFC §5.1.
 */
export interface PersistentStorePort {
  /** Persist (or overwrite, by id) a memory entry. */
  save(entry: MemoryEntry): Promise<void>
  /** Return entries matching the query, best-ranked first. */
  recall(query: MemoryQuery): Promise<MemoryEntry[]>
}

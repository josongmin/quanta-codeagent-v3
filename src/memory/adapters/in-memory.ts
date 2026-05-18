import type { PersistentStorePort } from "../ports"
import { rankEntries } from "../ranking"
import type { MemoryEntry, MemoryQuery } from "../types"

/**
 * Volatile {@link PersistentStorePort} (tests / ephemeral sessions).
 * Recall semantics are delegated to the shared {@link rankEntries} so they
 * stay identical to {@link SqliteStore}.
 */
export class InMemoryStore implements PersistentStorePort {
  private readonly entries = new Map<string, MemoryEntry>()

  /** Seed with initial entries (last write per id wins). */
  constructor(seed: readonly MemoryEntry[] = []) {
    for (const e of seed) this.entries.set(e.id, clone(e))
  }

  save(entry: MemoryEntry): Promise<void> {
    if (!entry.id) return Promise.reject(new Error("MemoryEntry.id is required"))
    // Upsert by id; defensive copy so external mutation can't corrupt store.
    this.entries.set(entry.id, clone(entry))
    return Promise.resolve()
  }

  recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    const ranked = rankEntries([...this.entries.values()], query)
    return Promise.resolve(ranked.map(clone))
  }

  /** Current entry count (test/diagnostic helper). */
  get size(): number {
    return this.entries.size
  }
}

const clone = (e: MemoryEntry): MemoryEntry => ({
  id: e.id,
  kind: e.kind,
  text: e.text,
  tags: [...e.tags],
  createdAt: e.createdAt,
  ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
})

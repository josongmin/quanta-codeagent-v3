import type { PersistentStorePort } from "../ports"
import { rankEntries } from "../ranking"
import { type MemoryEntry, type MemoryQuery, normalizeEntry } from "../types"

/**
 * Volatile {@link PersistentStorePort} (tests / ephemeral sessions).
 *
 * Stores normalized clones; the embedding array is deep-copied on the way in
 * AND out so external mutation can never corrupt the backing store. Recall
 * semantics are delegated wholesale to the shared {@link rankEntries} so they
 * stay identical to {@link import("./sqlite").SqliteStore}.
 */
export class InMemoryStore implements PersistentStorePort {
  private readonly entries = new Map<string, MemoryEntry>()

  /** Seed with initial entries (last write per id wins). */
  constructor(seed: readonly MemoryEntry[] = []) {
    for (const e of seed) this.entries.set(e.id, clone(normalizeEntry(e)))
  }

  save(entry: MemoryEntry): Promise<void> {
    if (!entry.id) return Promise.reject(new Error("MemoryEntry.id is required"))
    // Upsert by id; normalized defensive copy so external mutation can't corrupt store.
    this.entries.set(entry.id, clone(normalizeEntry(entry)))
    return Promise.resolve()
  }

  update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const existing = this.entries.get(id)
    if (!existing) return Promise.resolve()
    const merged: MemoryEntry = { ...existing, ...patch, updatedAt: Date.now() }
    this.entries.set(id, clone(normalizeEntry(merged)))
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id)
    return Promise.resolve()
  }

  get(id: string): Promise<MemoryEntry | undefined> {
    const e = this.entries.get(id)
    return Promise.resolve(e ? clone(normalizeEntry(e)) : undefined)
  }

  all(): Promise<MemoryEntry[]> {
    return Promise.resolve([...this.entries.values()].map((e) => clone(normalizeEntry(e))))
  }

  recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    const ranked = rankEntries([...this.entries.values()], query)
    return Promise.resolve(ranked.map((e) => clone(normalizeEntry(e))))
  }

  /** Current entry count (test/diagnostic helper). */
  get size(): number {
    return this.entries.size
  }
}

/** Deep-copy an entry, including the embedding array and the §10.6 routing
 *  `appliesTo` object (so external mutation can never corrupt the backing
 *  store — the class invariant). */
const clone = (e: MemoryEntry): MemoryEntry => ({
  ...e,
  tags: [...e.tags],
  ...(e.embedding !== undefined ? { embedding: [...e.embedding] } : {}),
  ...(e.appliesTo !== undefined ? { appliesTo: { ...e.appliesTo } } : {}),
})

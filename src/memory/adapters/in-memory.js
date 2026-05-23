import { rankEntries } from "../ranking";
import { normalizeEntry } from "../types";
/**
 * Volatile {@link PersistentStorePort} (tests / ephemeral sessions).
 *
 * Stores normalized clones; the embedding array is deep-copied on the way in
 * AND out so external mutation can never corrupt the backing store. Recall
 * semantics are delegated wholesale to the shared {@link rankEntries} so they
 * stay identical to {@link import("./sqlite").SqliteStore}.
 */
export class InMemoryStore {
    entries = new Map();
    /** Seed with initial entries (last write per id wins). */
    constructor(seed = []) {
        for (const e of seed)
            this.entries.set(e.id, clone(normalizeEntry(e)));
    }
    save(entry) {
        if (!entry.id)
            return Promise.reject(new Error("MemoryEntry.id is required"));
        // Upsert by id; normalized defensive copy so external mutation can't corrupt store.
        this.entries.set(entry.id, clone(normalizeEntry(entry)));
        return Promise.resolve();
    }
    update(id, patch) {
        const existing = this.entries.get(id);
        if (!existing)
            return Promise.resolve();
        const merged = { ...existing, ...patch, updatedAt: Date.now() };
        this.entries.set(id, clone(normalizeEntry(merged)));
        return Promise.resolve();
    }
    delete(id) {
        this.entries.delete(id);
        return Promise.resolve();
    }
    get(id) {
        const e = this.entries.get(id);
        return Promise.resolve(e ? clone(normalizeEntry(e)) : undefined);
    }
    all() {
        return Promise.resolve([...this.entries.values()].map((e) => clone(normalizeEntry(e))));
    }
    recall(query) {
        const ranked = rankEntries([...this.entries.values()], query);
        return Promise.resolve(ranked.map((e) => clone(normalizeEntry(e))));
    }
    /** Current entry count (test/diagnostic helper). */
    get size() {
        return this.entries.size;
    }
}
/** Deep-copy an entry, including the embedding array. */
const clone = (e) => ({
    ...e,
    tags: [...e.tags],
    ...(e.embedding !== undefined ? { embedding: [...e.embedding] } : {}),
});

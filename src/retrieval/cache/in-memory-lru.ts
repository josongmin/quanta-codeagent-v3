/**
 * ADR-0263 — Map-backed LRU adapter.
 *
 * Uses the JS `Map` insertion-order guarantee to model recency: every
 * `get`/`put` hit `delete`s the key and re-inserts it so the most-recent
 * entry is the last `keys()`-order entry. When `size > capacity` the
 * oldest entry (first key from the iterator) is evicted.
 *
 * The key is synchronous-hash-friendly: we use a fast non-crypto FNV-1a
 * mix over UTF-16 code units to stay sync (Web Crypto's `digest` is
 * async, but the EmbedCache port is sync). Collisions don't matter for
 * cache correctness because we also store the original text alongside
 * the modelTag, and `get` compares them post-hash. Collisions only
 * cost a re-embed (correctness preserved).
 *
 * Mutability boundary: stored vectors are frozen `readonly number[]`
 * copies; `get` returns a fresh copy so caller mutation cannot poison
 * the cache.
 */
import type { EmbedCache } from "./port"
import type { EmbedCacheHit } from "./types"

const DEFAULT_CAPACITY = 10_000

export interface InMemoryEmbedCacheOptions {
  /** Hard cap on resident entries. Default 10_000. */
  readonly capacity?: number
  /** Injectable clock for deterministic test assertions. */
  readonly now?: () => number
}

interface Entry {
  readonly text: string
  readonly modelTag: string
  readonly vector: readonly number[]
  readonly cachedAt: number
}

/** Fast non-cryptographic mix over UTF-16 code units. Sync, no allocations. */
const fastHash = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

const syncKey = (text: string, modelTag: string): string => `${fastHash(text)}:${modelTag}`

export const newInMemoryEmbedCache = (opts: InMemoryEmbedCacheOptions = {}): EmbedCache => {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY
  const now = opts.now ?? (() => Date.now())
  const store = new Map<string, Entry>()

  const evictIfOver = (): void => {
    while (store.size > capacity) {
      const oldest = store.keys().next()
      if (oldest.done === true || oldest.value === undefined) return
      store.delete(oldest.value)
    }
  }

  return {
    get(text, modelTag) {
      const key = syncKey(text, modelTag)
      const entry = store.get(key)
      if (entry === undefined) return null
      // collision guard: distinct (text, tag) sharing the same fast-hash slot
      if (entry.text !== text || entry.modelTag !== modelTag) return null
      // touch — re-insert at MRU end
      store.delete(key)
      store.set(key, entry)
      const hit: EmbedCacheHit = {
        vector: [...entry.vector],
        cachedAt: entry.cachedAt,
      }
      return hit
    },
    put(text, modelTag, vector) {
      const key = syncKey(text, modelTag)
      const entry: Entry = {
        text,
        modelTag,
        vector: Object.freeze([...vector]),
        cachedAt: now(),
      }
      store.delete(key) // ensure re-insert moves to MRU end
      store.set(key, entry)
      evictIfOver()
    },
    invalidate(modelTag) {
      let removed = 0
      for (const [k, entry] of store.entries()) {
        if (entry.modelTag === modelTag) {
          store.delete(k)
          removed++
        }
      }
      return removed
    },
    size() {
      return store.size
    },
    clear() {
      store.clear()
    },
  }
}

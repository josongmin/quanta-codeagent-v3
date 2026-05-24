/**
 * Conversation checkpoint store — lru-cache adapter (ADR-0184).
 *
 * Sibling of `./conversation-checkpoint.ts`. Same public interface
 * (`ConversationCheckpointStore`, `ConversationSnapshot`,
 * `ConversationCheckpointStoreOpts`, `ConversationCheckpointError` re-export),
 * backed by `lru-cache@11` instead of the hand-rolled `Map`.
 *
 * Rationale (user principle: "외부에 잘 만들어진 거 있으면 외부 거 써"):
 *   - lru-cache ships replacement / LRU touch / pop-LRU / iteration order as
 *     first-class primitives, with TTL + size-accounting follow-ups available
 *     without rewriting our store.
 *   - The hand-rolled Map impl stays as a sibling so the two adapters can be
 *     swapped at the construction site (no breaking-change risk).
 *
 * Semantic mapping vs. the Map impl:
 *   - `record(id, msgs)`:
 *       `cache.set(id, snapshot)` — when the key already exists, lru-cache
 *       both replaces the value AND moves the entry to the MRU position. So
 *       HELL-5 (replacement) and HELL-6 (LRU touch) collapse to a single set.
 *   - `list()`:
 *       `[...cache.entries()]` already iterates MRU→LRU, i.e. NEWEST first.
 *       No reverse needed, unlike the Map impl which iterates oldest→newest.
 *   - `restore(id)`:
 *       Uses `cache.peek(id)`, NOT `cache.get(id)`, so a read does NOT alter
 *       LRU order (parity with the Map impl, which never reorders on read).
 *   - `prune(keep)`:
 *       Uses `cache.pop()` (removes + returns the LRU entry) in a loop until
 *       `cache.size <= target`. `pop` is preferred over `delete(rkeys.next())`
 *       because it's a single O(1) call per eviction.
 *   - `clear()`:
 *       `cache.clear()`.
 *
 * Contract clauses (byte-identical to the Map impl):
 *   1. PURE STORE: in-memory only.
 *   2. NO-THROW except programmer-bug input (non-array messages).
 *   3. exactOptionalPropertyTypes: optional fields OMITTED, never undefined.
 *   4. IMMUTABILITY: shallow `Object.freeze(messages.slice())` before storing.
 *   5. LRU eviction: lru-cache fires automatically when `size > max`.
 *
 * Plane-clean: imports only `lru-cache`, `@/llm` (for the message type), and
 * the sibling `./conversation-checkpoint` (for the shared types + error class).
 */

import { LRUCache } from "lru-cache"
import type { Message } from "@/llm"
import {
  ConversationCheckpointError,
  type ConversationCheckpointStore,
  type ConversationCheckpointStoreOpts,
  type ConversationSnapshot,
} from "./conversation-checkpoint"

const DEFAULT_MAX_ENTRIES = 50

export const lruConversationCheckpointStore = (
  opts?: ConversationCheckpointStoreOpts,
): ConversationCheckpointStore => {
  // lru-cache requires `max >= 1`. Clamp 0/negative to 1 to mirror the Map
  // impl's HELL-13 behaviour ("maxEntries=0 → clamped to minimum").
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const now = opts?.now ?? Date.now
  const cache = new LRUCache<string, ConversationSnapshot>({ max: maxEntries })

  return {
    record(id, messages) {
      if (!Array.isArray(messages)) {
        throw new ConversationCheckpointError("record: messages must be an array")
      }
      const snapshot: ConversationSnapshot = {
        id,
        takenAt: now(),
        messages: Object.freeze(messages.slice()) as ReadonlyArray<Message>,
      }
      // `set` on an existing key replaces the value AND moves to MRU.
      // Eviction (when size would exceed `max`) is automatic.
      cache.set(id, snapshot)
    },

    list() {
      // `entries()` iterates MRU → LRU, i.e. newest first. Matches the Map
      // impl's reversed output and the shape of `shadow_snapshots`.
      const out: ConversationSnapshot[] = []
      for (const [, snap] of cache.entries()) out.push(snap)
      return out
    },

    restore(id) {
      // `peek` deliberately does NOT update LRU recency on read — parity
      // with the Map impl, which only reorders on `record` (write).
      const snap = cache.peek(id)
      return snap === undefined ? null : snap.messages
    },

    prune(keep) {
      const target = Math.max(0, Math.floor(keep))
      if (cache.size <= target) return 0
      let dropped = 0
      while (cache.size > target) {
        // `pop()` removes and returns the LRU entry; returns undefined when
        // empty, but the guard above + the while-condition prevents that.
        const removed = cache.pop()
        if (removed === undefined) break
        dropped += 1
      }
      return dropped
    },

    clear() {
      cache.clear()
    },
  }
}

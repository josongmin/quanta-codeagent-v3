/**
 * Conversation checkpoint store (ADR-0124).
 *
 * Pure in-memory snapshot/restore primitive for the agent's `messages[]` history,
 * the conversation-side counterpart to `ShadowOdb` (which snapshots files).
 *
 * SOTA absorption: Hermes Agent's `/rollback` restores BOTH file state and
 * conversation context in one shot. Cline's "Restore Files & Task" mode is the
 * same idea. Both competitors do conversation-level rollback in addition to file
 * rollback. quanta has file rollback (ADR-0118) but no conversation-level
 * primitive — this is the missing half.
 *
 * Default-OFF: nothing in the loop instantiates this store today. Callers
 * (apps/agent bootstrap, future `/rewind` slash command, future auto-recovery
 * hook) opt in by constructing `defaultConversationCheckpointStore()` and
 * recording at turn boundaries.
 *
 * Plane-clean: imports only `@/llm` (for the message shape). No `@/agent/loop`,
 * `@/agent/recovery`, `@/agent/session-resources`, `@/permission` — those are
 * the consumers, not collaborators of this primitive.
 *
 * Contract:
 *   1. PURE STORE: in-memory only; no I/O, no SQLite. Persistence is a follow-up.
 *   2. NO-THROW on the public surface (except programmer-bug input — non-array
 *      `messages`).
 *   3. exactOptionalPropertyTypes: optional `now` is OMITTED, never `undefined`.
 *   4. IMMUTABILITY: `record` snapshots a SHALLOW-FROZEN copy of the messages
 *      array so callers can keep mutating their array without corrupting the
 *      stored snapshot. (Deep freeze is intentionally not done — the inner
 *      Message objects are caller-owned and may legitimately be mutated by
 *      higher layers; the snapshot guarantee is at the array level.)
 *   5. LRU eviction: when the entry count exceeds `maxEntries`, the OLDEST
 *      (lowest `takenAt`) snapshots are dropped until the count fits.
 *      Re-`record`-ing the same id REPLACES the prior snapshot (and updates
 *      `takenAt`), it does NOT add a second.
 */

import type { Message } from "@/llm"

/** One captured conversation point. Returned by `list` and `restore`. */
export interface ConversationSnapshot {
  /** Caller-supplied id (typically the turn id or a UI-side label). Stable
   *  across replays. Empty string is permitted but discouraged. */
  readonly id: string
  /** Epoch-ms timestamp from the injected clock at the time `record` was called. */
  readonly takenAt: number
  /** Frozen shallow copy of the messages array at capture time. */
  readonly messages: ReadonlyArray<Message>
}

/** In-memory snapshot/restore primitive. Generic over `Message` (re-export from
 *  `@/llm`) so the consumer's exact message type doesn't leak in here. */
export interface ConversationCheckpointStore {
  /** Capture `messages` under `id`. Replaces any prior snapshot for the same id
   *  and updates its `takenAt`. Triggers LRU eviction if over cap. */
  record(id: string, messages: ReadonlyArray<Message>): void
  /** Return all snapshots, NEWEST first. Empty array when store is empty. */
  list(): ReadonlyArray<ConversationSnapshot>
  /** Return the snapshot with `id`'s messages, or `null` if not present.
   *  The returned array is the same frozen array stored at `record` time. */
  restore(id: string): ReadonlyArray<Message> | null
  /** Drop all but the `keep` newest snapshots. Returns evicted count.
   *  `keep` <= 0 is treated as `0` (clears everything). */
  prune(keep: number): number
  /** Remove every snapshot. */
  clear(): void
  /** ADR-0201 extension. Clone the snapshot under `srcId` to a new key `dstId`.
   *  Reuses the SAME frozen messages array (snapshot is immutable, sharing is
   *  safe). Returns `true` on success, `false` when `srcId` is missing OR
   *  `dstId` already exists (strict no-overwrite — overwrite would silently
   *  corrupt the parent if `dstId` ever collided). Triggers LRU eviction on
   *  successful insert (the source key is `peek`-ed, NOT touched). */
  cloneSnapshot(srcId: string, dstId: string): boolean
  /** ADR-0201 extension. Read-only lineage lookup: returns `{ parent }` where
   *  `parent` is the id this entry was forked FROM, or `null` if this id was
   *  recorded directly (root) OR is unknown to the lineage tracker. The
   *  default-impl tracks lineage in a sibling map; consumers that do not call
   *  `cloneSnapshot` get `{ parent: null }` for every id (byte-identical). */
  lineageOf(id: string): { parent: string | null }
}

export interface ConversationCheckpointStoreOpts {
  /** Cap on the number of snapshots retained. When `record` would exceed it,
   *  LRU eviction fires automatically. Default: 50 (Hermes ships max_snapshots
   *  20 by default but their snapshots are bigger; in-memory message arrays
   *  cost less, so 50 is a reasonable initial cap). */
  readonly maxEntries?: number
  /** Injected clock — tests pin it to assert deterministic `takenAt`.
   *  Default: `Date.now`. */
  readonly now?: () => number
}

class ConversationCheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationCheckpointError"
  }
}

const DEFAULT_MAX_ENTRIES = 50

export const defaultConversationCheckpointStore = (
  opts?: ConversationCheckpointStoreOpts,
): ConversationCheckpointStore => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const now = opts?.now ?? Date.now
  // Map preserves insertion order; we use that for LRU. On replacement we
  // delete then re-set to move the entry to the "newest" end.
  const store = new Map<string, ConversationSnapshot>()
  // ADR-0201 — child → parent map for `lineageOf`. Empty until `cloneSnapshot`
  // populates it; stores no payload beyond the parent id so cap parity with
  // `store` keeps the worst-case memory bounded (one entry per cloned snapshot,
  // and clones are evicted with the same LRU as `store`).
  const lineage = new Map<string, string>()

  const evictIfOver = (): void => {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
      // Lineage is keyed by child id (== store key for clones). Drop in lock-
      // step so stale parent pointers do not survive their owning snapshot.
      lineage.delete(oldestKey)
    }
  }

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
      // Replacement: delete then set so the id moves to "newest" position.
      if (store.has(id)) store.delete(id)
      store.set(id, snapshot)
      evictIfOver()
    },

    list() {
      // Map keys are oldest→newest; we surface newest-first to match the
      // shape of `shadow_snapshots` (consistency across surfaces).
      const arr = Array.from(store.values())
      arr.reverse()
      return arr
    },

    restore(id) {
      const snap = store.get(id)
      return snap === undefined ? null : snap.messages
    },

    prune(keep) {
      const target = Math.max(0, Math.floor(keep))
      if (store.size <= target) return 0
      const dropCount = store.size - target
      const keys = Array.from(store.keys()).slice(0, dropCount) // oldest first
      for (const k of keys) store.delete(k)
      return dropCount
    },

    clear() {
      store.clear()
      lineage.clear()
    },

    cloneSnapshot(srcId, dstId) {
      if (srcId === dstId) return false
      const src = store.get(srcId)
      if (src === undefined) return false
      if (store.has(dstId)) return false
      // Reuse the frozen array — snapshots are immutable post-record so
      // sharing is safe and avoids a copy.
      const clone: ConversationSnapshot = {
        id: dstId,
        takenAt: now(),
        messages: src.messages,
      }
      store.set(dstId, clone)
      lineage.set(dstId, srcId)
      evictIfOver()
      return true
    },

    lineageOf(id) {
      const parent = lineage.get(id)
      return { parent: parent === undefined ? null : parent }
    },
  }
}

export { ConversationCheckpointError }

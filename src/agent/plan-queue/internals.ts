/**
 * Internal helpers for {@link defaultPlanQueueStore} (see `../plan-queue.ts`).
 *
 * Behavior-preserving extraction: each store method body and each nested
 * helper from the factory closure now lives at module level, taking the
 * closed-over state/deps as an explicit {@link Deps} bag. The factory threads
 * the SAME references (the `store` Map by reference, `counter` boxed) so
 * mutation semantics are byte-identical. Plane-clean — same imports as the
 * parent (`@/shared` type-only Result; no runtime deps beyond the parent's).
 */

import type { Result } from "@/shared"
import {
  type EnqueueResult,
  type Entry,
  type FollowUp,
  MAX_FOLLOWUP_TEXT_BYTES,
  type QueueMutateError,
  type SendNowInjection,
  type SendNowSink,
  toSnapshot,
} from "../plan-queue-shared"

/** Mutable single-element counter box so the boxed primitive is shared by
 *  reference between the factory and the extracted helpers (a bare number
 *  would copy). */
export interface CounterBox {
  value: number
}

/** Closed-over state + injected deps for the plan-queue store, passed by
 *  reference so the extracted helpers mutate the SAME `store`/`counter`/
 *  `urgent` flags the factory exposes. */
export interface Deps {
  readonly maxPerThread: number
  readonly now: () => number
  readonly hash: (text: string) => string
  readonly sendNowSink: SendNowSink | undefined
  /** Per-thread queue: insertion order = arrival order. Shared BY REFERENCE. */
  readonly store: Map<string, Entry[]>
  /** Per-store monotone counter, boxed so increments are shared. */
  readonly counter: CounterBox
}

/** Local Result constructors — duplicated here so plan-queue keeps its
 *  zero-runtime-dep posture (`@/shared` is type-only). */
const okR = <T>(value: T): Result<T, never> => ({ ok: true, value })
const errR = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** Search live (non-drained) entries for a dedup match. */
const findDedup = (queue: Entry[], textHash: string): Entry | undefined => {
  for (const e of queue) {
    if (e.drainedIntoTurn === null && e.textHash === textHash) return e
  }
  return undefined
}

/** Find the index of the oldest live entry in `queue` matching `predicate`.
 *  "Oldest" = smallest `enqueuedAtMs`. Drained entries are ALWAYS skipped
 *  (they're zombies awaiting GC). Returns -1 if no match. */
const findOldestLiveIndex = (queue: Entry[], predicate: (e: Entry) => boolean): number => {
  let bestIdx = -1
  let bestAt = Number.POSITIVE_INFINITY
  for (let i = 0; i < queue.length; i++) {
    const e = queue[i]
    if (e === undefined) continue
    if (e.drainedIntoTurn !== null) continue
    if (!predicate(e)) continue
    if (e.enqueuedAtMs < bestAt) {
      bestIdx = i
      bestAt = e.enqueuedAtMs
    }
  }
  return bestIdx
}

const isNonUrgent = (e: Entry): boolean => !e.urgent
const isAnyLive = (_e: Entry): boolean => true

/** LRU eviction: drop oldest non-urgent; if all urgent, drop oldest
 *  urgent (documented trade-off — the cap is a hard ceiling). */
const evictIfOver = (queue: Entry[], maxPerThread: number): void => {
  while (queue.length > maxPerThread) {
    // Tier 1: oldest non-urgent.
    const nonUrgentIdx = findOldestLiveIndex(queue, isNonUrgent)
    if (nonUrgentIdx >= 0) {
      queue.splice(nonUrgentIdx, 1)
      continue
    }
    // Tier 2 (all-urgent fallback): oldest urgent. Caller cannot prevent
    // overflow ⇒ we MUST drop something. Documented in contract #6.
    const urgentIdx = findOldestLiveIndex(queue, isAnyLive)
    if (urgentIdx >= 0) {
      queue.splice(urgentIdx, 1)
      continue
    }
    // Nothing live to evict (every entry is drained — drain would have
    // removed them). Defensive break to avoid infinite loop.
    break
  }
}

/** Private enqueue body — used by both the public `enqueue` and `retry`.
 *  Returns the LIVE entry on dedup-collapse and the freshly-created
 *  entry on a clean insert (callers can read `.id` on either). */
export const enqueueInternal = (
  deps: Deps,
  input: Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">,
): { entry: Entry; collapsed: boolean } => {
  const { hash, now, store, counter, maxPerThread } = deps
  const textHash = hash(input.text)
  const queue = store.get(input.threadId) ?? []
  if (!store.has(input.threadId)) store.set(input.threadId, queue)

  // Dedup: identical (threadId, textHash) among LIVE entries collapses.
  const existing = findDedup(queue, textHash)
  if (existing !== undefined) {
    // OR-in urgent — caller's later "this is actually urgent" should
    // upgrade the existing entry, never downgrade.
    if (input.urgent) existing.urgent = true
    return { entry: existing, collapsed: true }
  }

  counter.value += 1
  const id = `fu-${input.threadId}-${counter.value}`
  const enqueuedAtMs = now()
  const base: Entry = {
    id,
    threadId: input.threadId,
    text: input.text,
    source: input.source,
    enqueuedAtMs,
    pausedReason: input.pausedReason,
    arrivedDuringTurn: input.arrivedDuringTurn,
    urgent: input.urgent,
    drainedIntoTurn: null,
    metadata: input.metadata,
    // `label` is conditionally added below (exactOptional).
    textHash,
  }
  const withLabel: Entry = input.label !== undefined ? { ...base, label: input.label } : base
  queue.push(withLabel)
  evictIfOver(queue, maxPerThread)
  return { entry: withLabel, collapsed: false }
}

/** Inner scan of one thread's queue for a live id match. Extracted so
 *  the outer `locateLive` stays under biome's cognitive-complexity cap
 *  (the nested loop + 3-way branch otherwise tips it to 17). */
const scanQueueForId = (
  queue: Entry[],
  entryId: string,
): { index: number; entry: Entry } | null => {
  for (let i = 0; i < queue.length; i++) {
    const e = queue[i]
    if (e === undefined || e.id !== entryId) continue
    // drained id ⇒ tombstone (we don't actually keep these but the
    // guard documents the contract); same as not found for callers.
    if (e.drainedIntoTurn !== null) return null
    return { index: i, entry: e }
  }
  return null
}

/** Locate a LIVE entry by id (linear over all threads — queues are
 *  capped so the worst case is `maxPerThread × thread-count`, tiny in
 *  practice). Returns `null` when the entry is missing OR drained. */
const locateLive = (
  store: Map<string, Entry[]>,
  entryId: string,
): { queue: Entry[]; index: number; entry: Entry } | null => {
  for (const queue of store.values()) {
    const hit = scanQueueForId(queue, entryId)
    if (hit !== null) return { queue, ...hit }
  }
  return null
}

/** Find the threadId whose array reference is `queue`. Reverse lookup —
 *  small Map so the O(n) sweep is trivial in practice. Returns
 *  undefined when the queue is no longer tracked (defensive only). */
const findThreadIdForQueue = (store: Map<string, Entry[]>, queue: Entry[]): string | undefined => {
  for (const [tid, q] of store.entries()) {
    if (q === queue) return tid
  }
  return undefined
}

/** Delete the empty queue's map entry so `inspect`/`peek` see no stale
 *  thread keys. No-op when the queue is non-empty. */
const cleanupEmptyQueue = (store: Map<string, Entry[]>, queue: Entry[]): void => {
  if (queue.length !== 0) return
  const tid = findThreadIdForQueue(store, queue)
  if (tid !== undefined) store.delete(tid)
}

/** Validate `newText` for `edit`. Returns the validated string on ok,
 *  the typed error on reject. Extracted to keep `edit` under the
 *  cognitive-complexity cap. */
const validateEditText = (newText: unknown): Result<string, QueueMutateError> => {
  if (typeof newText !== "string") return errR("invalid-text")
  if (newText.trim().length === 0) return errR("invalid-text")
  if (Buffer.byteLength(newText, "utf8") > MAX_FOLLOWUP_TEXT_BYTES) return errR("invalid-text")
  return okR(newText)
}

/** Find a LIVE entry on `queue` whose `textHash` matches `nextHash` and
 *  is NOT `excluded`. Returns the merge target on hit, `null` on miss.
 *  Used by `edit` to detect collapse-with-sibling. */
const findMergeTarget = (queue: Entry[], excluded: Entry, nextHash: string): Entry | null => {
  for (const other of queue) {
    if (other === excluded || other.drainedIntoTurn !== null) continue
    if (other.textHash === nextHash) return other
  }
  return null
}

// ─── Public method bodies (delegated to by the factory) ──────────────

export const enqueueMethod = (
  deps: Deps,
  input: Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">,
): EnqueueResult => {
  const { entry, collapsed } = enqueueInternal(deps, input)
  return { id: entry.id, collapsed }
}

export const drainMethod = (
  deps: Deps,
  threadId: string,
  currentTurn: number,
): ReadonlyArray<FollowUp> => {
  const { store } = deps
  const queue = store.get(threadId)
  if (queue === undefined || queue.length === 0) return []
  // Snapshot live entries in (urgent first, then enqueued order)
  // ordering. Stable sort: ties resolved by enqueue order (array index).
  const live = queue.filter((e) => e.drainedIntoTurn === null)
  if (live.length === 0) return []
  const indexed = live.map((e, idx) => ({ e, idx }))
  indexed.sort((a, b) => {
    // urgent first (true > false)
    if (a.e.urgent !== b.e.urgent) return a.e.urgent ? -1 : 1
    // then enqueuedAtMs ascending
    if (a.e.enqueuedAtMs !== b.e.enqueuedAtMs) return a.e.enqueuedAtMs - b.e.enqueuedAtMs
    // then original index (stable tiebreak)
    return a.idx - b.idx
  })
  const drained: FollowUp[] = []
  for (const { e } of indexed) {
    e.drainedIntoTurn = currentTurn
    drained.push(toSnapshot(e))
  }
  // Remove drained entries from the live queue so future dedup /
  // peek / inspect see only live entries.
  const remaining = queue.filter((e) => e.drainedIntoTurn === null)
  if (remaining.length === 0) {
    store.delete(threadId)
  } else {
    // Replace contents in-place to keep the same array identity.
    queue.length = 0
    queue.push(...remaining)
  }
  return drained
}

export const peekMethod = (deps: Deps, threadId: string): ReadonlyArray<FollowUp> => {
  const queue = deps.store.get(threadId)
  if (queue === undefined || queue.length === 0) return []
  const live = queue.filter((e) => e.drainedIntoTurn === null)
  return live.map(toSnapshot)
}

export const clearMethod = (deps: Deps, threadId: string): number => {
  const { store } = deps
  const queue = store.get(threadId)
  if (queue === undefined) return 0
  const n = queue.filter((e) => e.drainedIntoTurn === null).length
  store.delete(threadId)
  return n
}

export const inspectMethod = (deps: Deps): ReadonlyMap<string, ReadonlyArray<FollowUp>> => {
  const snapshot = new Map<string, ReadonlyArray<FollowUp>>()
  for (const [tid, queue] of deps.store.entries()) {
    const live = queue.filter((e) => e.drainedIntoTurn === null)
    if (live.length === 0) continue
    snapshot.set(tid, live.map(toSnapshot))
  }
  return snapshot
}

export const findEntryMethod = (deps: Deps, entryId: string): FollowUp | undefined => {
  const located = locateLive(deps.store, entryId)
  return located === null ? undefined : toSnapshot(located.entry)
}

export const retryMethod = (deps: Deps, entryId: string): Result<FollowUp, QueueMutateError> => {
  const located = locateLive(deps.store, entryId)
  if (located === null) return errR("not-found")
  const { queue, index, entry } = located
  // `already-active` is the guard for a future async-mutation regime —
  // today the store is synchronous single-threaded JS so the entry is
  // unambiguously LIVE here. The variant exists in the public Result
  // shape for forward-compat (the typed-error union is closed).
  //
  // Retry semantics: REMOVE the source entry, then re-enqueue with a
  // FRESH id + enqueuedAtMs + textHash. The remove-first step avoids
  // the dedup-with-self pitfall (`enqueueInternal` would collapse to
  // the source entry's id, returning a stale handle). The caller
  // observes the NEW snapshot in the success channel — the old id is
  // gone from the queue.
  queue.splice(index, 1)
  // If the queue is now empty, leave it — enqueueInternal will reuse
  // the same array reference (it does `store.get(threadId) ?? []`).
  const re = enqueueInternal(deps, {
    threadId: entry.threadId,
    text: entry.text,
    source: entry.source,
    pausedReason: entry.pausedReason,
    arrivedDuringTurn: entry.arrivedDuringTurn,
    urgent: entry.urgent,
    metadata: entry.metadata,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  })
  return okR(toSnapshot(re.entry))
}

export const editMethod = (
  deps: Deps,
  entryId: string,
  newText: string,
): Result<FollowUp, QueueMutateError> => {
  const located = locateLive(deps.store, entryId)
  if (located === null) return errR("not-found")
  const validated = validateEditText(newText)
  if (!validated.ok) return validated
  const text = validated.value

  const { queue, index, entry } = located
  const nextHash = deps.hash(text)
  // No-op edit: same text ⇒ same hash. Fast-path avoids dedup work.
  if (nextHash === entry.textHash && text === entry.text) {
    return okR(toSnapshot(entry))
  }
  // Collapse-with-sibling: merge urgency + drop this, return survivor.
  // Mirrors enqueue-side dedup so edit + enqueue converge on same end.
  const mergeTarget = findMergeTarget(queue, entry, nextHash)
  if (mergeTarget !== null) {
    if (entry.urgent) mergeTarget.urgent = true
    queue.splice(index, 1)
    return okR(toSnapshot(mergeTarget))
  }
  // In-place text + hash swap. `text` and `textHash` are declared
  // `readonly` on `Entry` AND `FollowUp` — we bypass via a scoped
  // non-readonly view so external callers still cannot mutate while
  // the store retains the right to mutate its own internal records.
  const mutable = entry as { text: string; textHash: string }
  mutable.text = text
  mutable.textHash = nextHash
  return okR(toSnapshot(entry))
}

export const deleteMethod = (deps: Deps, entryId: string): Result<void, QueueMutateError> => {
  const located = locateLive(deps.store, entryId)
  if (located === null) return errR("not-found")
  const { queue, index } = located
  queue.splice(index, 1)
  cleanupEmptyQueue(deps.store, queue)
  return okR(undefined)
}

export const sendNowMethod = (deps: Deps, entryId: string): Result<void, QueueMutateError> => {
  const { store, sendNowSink } = deps
  const located = locateLive(store, entryId)
  if (located === null) return errR("not-found")
  const { queue, index, entry } = located

  // Remove FIRST so a sink-side throw can't leave the entry in a
  // half-state (contract on the public docs: "entry removed before
  // sink call"). If the sink rejects, caller sees error + removed
  // entry; they can re-enqueue if intent demands.
  queue.splice(index, 1)
  cleanupEmptyQueue(store, queue)

  if (sendNowSink === undefined) return errR("send-not-possible")

  const payload: SendNowInjection = {
    threadId: entry.threadId,
    text: entry.text,
    source: entry.source,
    enqueuedAtMs: entry.enqueuedAtMs,
    metadata: entry.metadata,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  }
  // No-throw guard: callers MUST NOT see a thrown error from a sink
  // they wired. Convert any throw / non-ok result to typed error.
  try {
    const r = sendNowSink.inject(payload)
    return r.ok === true ? okR(undefined) : errR("send-not-possible")
  } catch {
    return errR("send-not-possible")
  }
}

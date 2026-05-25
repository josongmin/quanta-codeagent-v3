/**
 * Default todo-readback store (ADR-0255).
 *
 * Map-backed in-memory implementation. Each session holds a frozen
 * `TodoSnapshot` + a Set of subscribers. A separate Map tracks
 * parent→child linkages so `propagate(child, parent)` is O(1).
 *
 * Concurrency: single-threaded (Node). Under interleaved `updateFrom`
 * calls the injected clock orders writes (last-write-wins by
 * `updatedAt`). The clock is monotonically strictly-increasing even
 * if the caller's clock function ever returns a stale value, by
 * advancing past the previous timestamp + 1.
 */

import { err, ok, type Result } from "@/shared"
import type { SnapshotCallback, Subscription, TodoReadback } from "./port"
import type { TodoItem, TodoSnapshot, UpdateError } from "./types"

export interface DefaultStoreOpts {
  /** Injectable clock — returns a monotonic timestamp. Default:
   *  `Date.now`. The store guards against non-monotonic clocks by
   *  advancing past the previous tick + 1 internally. */
  readonly clock?: () => number
}

const EMPTY_SNAPSHOT: TodoSnapshot = Object.freeze({
  items: Object.freeze([] as readonly TodoItem[]),
  updatedAt: 0,
})

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0

const isTodoItem = (v: unknown): v is TodoItem => {
  if (v === null || typeof v !== "object") return false
  const o = v as { id?: unknown; text?: unknown; status?: unknown }
  if (!isString(o.id)) return false
  if (typeof o.text !== "string") return false
  if (o.status !== "pending" && o.status !== "in_progress" && o.status !== "completed") {
    return false
  }
  return true
}

const freezeItem = (i: TodoItem): TodoItem =>
  Object.freeze({ id: i.id, text: i.text, status: i.status })

const freezeSnapshot = (items: readonly TodoItem[], updatedAt: number): TodoSnapshot =>
  Object.freeze({
    items: Object.freeze(items.map(freezeItem)),
    updatedAt,
  })

/** Merge `incoming` into `current`: upsert by `id`, append unknown ids
 *  in their original order. Returns a fresh frozen array. */
const mergeItems = (
  current: readonly TodoItem[],
  incoming: readonly TodoItem[],
): readonly TodoItem[] => {
  const byId = new Map<string, TodoItem>()
  for (const item of current) byId.set(item.id, item)
  const appended: TodoItem[] = []
  for (const item of incoming) {
    if (!isTodoItem(item)) continue
    if (byId.has(item.id)) {
      byId.set(item.id, item)
    } else {
      byId.set(item.id, item)
      appended.push(item)
    }
  }
  // Preserve original ordering: keep existing items in place (by their
  // first-seen order in `current`), then append new ids in arrival
  // order. Items absent from `incoming` are retained as-is.
  const result: TodoItem[] = []
  const seen = new Set<string>()
  for (const item of current) {
    const next = byId.get(item.id)
    if (next) {
      result.push(next)
      seen.add(item.id)
    }
  }
  for (const item of appended) {
    if (!seen.has(item.id)) {
      result.push(item)
      seen.add(item.id)
    }
  }
  return result
}

interface SessionState {
  snapshot: TodoSnapshot
  subscribers: Set<SnapshotCallback>
}

export const defaultTodoReadbackStore = (opts: DefaultStoreOpts = {}): TodoReadback => {
  const clock = opts.clock ?? Date.now
  const sessions = new Map<string, SessionState>()
  // parent ←→ child linkages. We only need child→parent for
  // `propagate`, but keep parent→children for future fan-out helpers.
  const childToParent = new Map<string, string>()
  let lastTick = 0

  const tick = (): number => {
    let now = clock()
    if (!Number.isFinite(now)) now = lastTick + 1
    if (now <= lastTick) now = lastTick + 1
    lastTick = now
    return now
  }

  const ensureSession = (sessionId: string): SessionState => {
    let s = sessions.get(sessionId)
    if (!s) {
      s = { snapshot: EMPTY_SNAPSHOT, subscribers: new Set() }
      sessions.set(sessionId, s)
    }
    return s
  }

  const emit = (sessionId: string, snapshot: TodoSnapshot): void => {
    const s = sessions.get(sessionId)
    if (!s) return
    for (const cb of s.subscribers) {
      try {
        cb(snapshot)
      } catch {
        // swallow — one bad subscriber MUST NOT starve siblings.
      }
    }
  }

  return {
    snapshotFor(sessionId) {
      if (!isString(sessionId)) return EMPTY_SNAPSHOT
      const s = sessions.get(sessionId)
      return s ? s.snapshot : EMPTY_SNAPSHOT
    },

    updateFrom(sessionId, partial): Result<void, UpdateError> {
      if (!isString(sessionId)) {
        return err({ kind: "session-not-found", sessionId: String(sessionId) })
      }
      const s = sessions.get(sessionId)
      if (!s) {
        return err({ kind: "session-not-found", sessionId })
      }
      const incoming = Array.isArray(partial?.items) ? partial.items : []
      const merged = mergeItems(s.snapshot.items, incoming)
      const next = freezeSnapshot(merged, tick())
      s.snapshot = next
      emit(sessionId, next)
      return ok(undefined)
    },

    link(parent, child) {
      if (!isString(parent) || !isString(child)) return
      ensureSession(parent)
      ensureSession(child)
      childToParent.set(child, parent)
    },

    subscribe(sessionId, cb, opts): Subscription {
      if (!isString(sessionId) || typeof cb !== "function") {
        return { unsubscribe: () => {} }
      }
      const s = ensureSession(sessionId)
      s.subscribers.add(cb)
      let active = true
      const unsubscribe = (): void => {
        if (!active) return
        active = false
        s.subscribers.delete(cb)
      }
      // Optional snapshot-on-subscribe — deliver synchronously BEFORE
      // returning so the caller's first event ordering is deterministic.
      const wantSnapshot = opts?.snapshot === true
      if (wantSnapshot) {
        try {
          cb(s.snapshot)
        } catch {
          // swallow per emit() contract.
        }
      }
      // Optional AbortSignal wiring. If already aborted, unsubscribe
      // immediately so no future emit can fire.
      const signal = opts?.signal
      if (signal) {
        if (signal.aborted) {
          unsubscribe()
        } else {
          // `once: true` so we don't leak a listener after one abort.
          signal.addEventListener("abort", unsubscribe, { once: true })
        }
      }
      return { unsubscribe }
    },

    propagate(childSessionId, parentSessionId) {
      if (!isString(childSessionId) || !isString(parentSessionId)) return
      const linkedParent = childToParent.get(childSessionId)
      // Defensive: only propagate when the linkage matches what the
      // caller asked for. This catches typos / cross-wired parents.
      if (linkedParent !== parentSessionId) return
      const child = sessions.get(childSessionId)
      const parent = sessions.get(parentSessionId)
      if (!child || !parent) return
      const merged = mergeItems(parent.snapshot.items, child.snapshot.items)
      const next = freezeSnapshot(merged, tick())
      parent.snapshot = next
      emit(parentSessionId, next)
    },
  }
}

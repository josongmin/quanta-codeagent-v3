/**
 * Activity subscription protocol (RFC-04 R6 D1).
 *
 * The landed store can `emit`/`snapshot` but has no way for a LIVE consumer (the
 * CLI progress renderer, a web bridge) to follow changes without a race. A naive
 * consumer that does `snap = store.snapshot(); store.onChange(listener)` LOSES
 * any event that lands in the window between capture and registration.
 *
 * This module defines the narrow ports (ISP — a subscriber sees only what it
 * needs) and the ONE coalescing subscription that closes that window:
 *
 *  - **Atomic {snapshot, nextSeq}.** {@link createActivitySubscription} registers
 *    the raw listener BEFORE the source captures its snapshot+seq, then DROPS any
 *    delivered event with `seq <= baseSeq` (already reflected in the snapshot).
 *    So an event injected mid-capture is either in the snapshot (seq <= baseSeq)
 *    OR delivered (seq > baseSeq) — never both (duplication) and never neither
 *    (loss). `nextSeq === baseSeq + 1` is the exact partition boundary.
 *  - **Ordered lifecycle delivery + bounded coalescing.** Lifecycle events
 *    (`node_open`/`node_status`/`node_metric`) are appended in arrival order and
 *    NEVER coalesced. A `node_progress` update coalesces IN PLACE onto the same
 *    node's pending progress slot — so a burst of checkout-% updates collapses to
 *    the latest (bounded: at most one pending progress slot per node between that
 *    node's lifecycle transitions). Any lifecycle event for a node SEALS its
 *    progress slot, so a later progress can never jump back before that
 *    transition — lifecycle order is preserved.
 *
 * Pure-of-I/O leaf: imports only sibling types + the default microtask
 * scheduler. No `@/runtime`, no peer/Layer-2 import.
 */

import type { ActivityEvent, ActivitySnapshot } from "./types"

/** One delivered change: the store-level monotonic `seq` + the raw event. The
 *  snapshot is fetched on demand by the subscriber (CLI owns redraw), so a
 *  change stays a light ordering/identity token. */
export interface ActivityChange {
  readonly seq: number
  readonly event: ActivityEvent
}

/** A change listener. Receives every event with `seq >= nextSeq`, in order,
 *  with `node_progress` bursts coalesced. */
export type ActivityListener = (change: ActivityChange) => void

/** Read-only snapshot port (a renderer that only needs the current tree). */
export interface ActivitySnapshotReader {
  snapshot(): ActivitySnapshot
}

/** The monotonic sequence source (last-applied event's seq; 0 before any emit). */
export interface ActivitySeqSource {
  readonly seq: number
}

/**
 * The low-level atomic attach primitive a source (the store) exposes. `attach`
 * MUST, in one synchronous step: register `raw`, then capture the snapshot and
 * the seq of the last event reflected in it. Registering FIRST is what makes the
 * subscription race-free — any event delivered during capture is seen by `raw`
 * and reconciled against `seq`.
 */
export interface RawActivitySource {
  attach(raw: (change: ActivityChange) => void): {
    readonly snapshot: ActivitySnapshot
    /** Seq of the last event reflected in `snapshot` (0 if none). */
    readonly seq: number
    detach(): void
  }
}

/** A live subscription handle. `snapshot` + `nextSeq` are the atomic initial
 *  view; `unsubscribe` detaches (idempotent). */
export interface ActivitySubscription {
  /** The atomic initial snapshot (reflects every event with `seq < nextSeq`). */
  readonly snapshot: ActivitySnapshot
  /** The first `seq` the listener will receive (`= baseSeq + 1`). */
  readonly nextSeq: number
  unsubscribe(): void
}

/** Options for {@link createActivitySubscription}. */
export interface SubscribeOptions {
  /** Schedules a flush of coalesced changes. Default: `queueMicrotask`. Tests
   *  inject a manual scheduler for deterministic batching (coalescing needs a
   *  batch window — a synchronous per-event flush cannot coalesce). */
  readonly schedule?: (flush: () => void) => void
}

const eventNodeId = (event: ActivityEvent): string =>
  event.type === "node_open" ? event.node.id : event.id

const defaultSchedule = (flush: () => void): void => {
  queueMicrotask(flush)
}

/**
 * Create a coalescing, race-free subscription over a {@link RawActivitySource}.
 * Returns the atomic `{snapshot, nextSeq}` immediately; the `listener` receives
 * every subsequent change (seq > baseSeq) in order, progress-coalesced, on the
 * scheduled flush boundary.
 */
export const createActivitySubscription = (
  source: RawActivitySource,
  listener: ActivityListener,
  opts?: SubscribeOptions,
): ActivitySubscription => {
  const schedule = opts?.schedule ?? defaultSchedule
  let pending: ActivityChange[] = []
  // nodeId -> index of that node's coalescable progress slot in `pending`.
  const progressSlot = new Map<string, number>()
  let flushScheduled = false
  let baseSeq = -1 // set once attach reports it (see below)
  let closed = false

  const flush = (): void => {
    flushScheduled = false
    if (pending.length === 0) return
    const batch = pending
    pending = []
    progressSlot.clear()
    for (const change of batch) listener(change)
  }

  const enqueue = (change: ActivityChange): void => {
    const id = eventNodeId(change.event)
    if (change.event.type === "node_progress") {
      const at = progressSlot.get(id)
      if (at !== undefined) {
        pending[at] = change // coalesce in place — order preserved, bounded to 1/node
      } else {
        progressSlot.set(id, pending.length)
        pending.push(change)
      }
    } else {
      // A lifecycle transition SEALS this node's progress slot so a later
      // progress opens a fresh slot AFTER it (never reorders before it).
      progressSlot.delete(id)
      pending.push(change)
    }
    if (!flushScheduled) {
      flushScheduled = true
      schedule(flush)
    }
  }

  const raw = (change: ActivityChange): void => {
    if (closed) return
    // Drop anything already reflected in the atomic snapshot. During attach
    // `baseSeq` is still -1, so a mid-capture event is enqueued now and PURGED
    // below once `baseSeq` is known — the no-loss/no-dup reconciliation.
    if (change.seq <= baseSeq) return
    enqueue(change)
  }

  const attached = source.attach(raw)
  baseSeq = attached.seq
  // Reconcile any mid-capture events: anything with seq <= baseSeq is already in
  // the snapshot; purge it (and rebuild the coalescing index over survivors).
  if (pending.length > 0) {
    const survivors = pending.filter((c) => c.seq > baseSeq)
    pending = []
    progressSlot.clear()
    for (const c of survivors) enqueue(c)
  }

  return {
    snapshot: attached.snapshot,
    nextSeq: baseSeq + 1,
    unsubscribe: () => {
      if (closed) return
      closed = true
      attached.detach()
      pending = []
      progressSlot.clear()
    },
  }
}

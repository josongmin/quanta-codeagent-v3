/**
 * ADR-0319 — Default in-memory `TypedHistoryEventStore` adapter.
 *
 * Append-only array. No I/O, no clock injection (producers stamp `at`
 * themselves so the store is a pure container). `since` runs a linear
 * filter — under the documented `N < 10k` per-session assumption this
 * is fast enough, and we deliberately do NOT bake in a non-decreasing
 * `at` invariant (producers across surfaces share a wall clock with
 * skew tolerances; a binary search would silently misbehave on the
 * first out-of-order event).
 *
 * Reference equality on `snapshot()` is NOT preserved across appends:
 * a fresh frozen array is returned each call so callers can iterate
 * without observing later mutations.
 *
 * Closed-port DIP: this impl is the contract reference for
 * `TypedHistoryEventStore`. Any alternate adapter must pass every
 * assertion in the slice's hellgate suite.
 */

import type { TypedHistoryEventStore } from "./port"
import type { TypedHistoryEvent } from "./types"

class InMemoryTypedHistoryEventStore implements TypedHistoryEventStore {
  private events: TypedHistoryEvent[] = []

  append(event: TypedHistoryEvent): void {
    this.events.push(event)
  }

  snapshot(): readonly TypedHistoryEvent[] {
    return Object.freeze([...this.events])
  }

  since(at: number): readonly TypedHistoryEvent[] {
    const out: TypedHistoryEvent[] = []
    for (const e of this.events) {
      if (e.at >= at) out.push(e)
    }
    return Object.freeze(out)
  }

  clear(): void {
    this.events = []
  }
}

/**
 * Construct a fresh in-memory typed-history event store. The default
 * adapter is exported only as a factory — the class is not part of the
 * public surface (see barrel `./index.ts`).
 */
export const createInMemoryTypedHistoryEventStore = (): TypedHistoryEventStore =>
  new InMemoryTypedHistoryEventStore()

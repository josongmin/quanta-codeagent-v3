/**
 * Bounded typed-history reader for context-change prompt injection.
 *
 * The typed-event store is append-only, while prompt assembly must never turn
 * an accumulated session history into an unbounded prompt addition. This
 * reader owns an index cursor and exposes newly appended events in insertion
 * order, at most `maxEvents` per call. It is deliberately DI-only: callers
 * opt in by constructing it and passing `read` into their existing turn wire;
 * without that wire this module has no runtime effect.
 *
 * Failure posture is fail-closed. A broken store snapshot returns no events
 * and does not advance the cursor, so the next healthy read can retry. A
 * `clear()` is detected by a shorter snapshot and starts a fresh cursor at 0.
 */

import type { TypedHistoryEventStore } from "@/memory/typed-event"
import type { ContextEvent } from "./types"

/** Default ceiling for one prompt build. Kept small enough that an accidental
 * burst cannot dominate the user turn, while preserving remaining events for
 * later reads. */
const DEFAULT_MAX_EVENTS = 16

/** Reader surface intentionally has one operation: consume the next bounded
 * insertion-ordered window. The returned array is frozen to prevent a caller
 * from mutating the store-derived event view before prompt rendering. */
export interface ContextEventStoreReader {
  read(): readonly ContextEvent[]
}

export interface ContextEventStoreReaderOptions {
  /** Maximum events returned by one `read`. Invalid runtime values fail closed
   * to the conservative default rather than producing an unbounded slice. */
  readonly maxEvents?: number
  /** Optional owner-supplied selection predicate. Non-matching events are
   * consumed from the append cursor but never spend the prompt-event budget.
   * This keeps one shared typed-history store from delaying a sparse event kind
   * behind unrelated context or mention history. */
  readonly include?: (event: ContextEvent) => boolean
}

const resolveMaxEvents = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_EVENTS

interface SelectedWindow {
  readonly events: readonly ContextEvent[]
  readonly nextCursor: number
}

/** Advance through the shared append log until the prompt budget is filled.
 * Non-matches still advance the cursor: they belong to another owner and must
 * never keep this reader parked ahead of a later selected event. */
const selectWindow = (
  snapshot: readonly ContextEvent[],
  cursor: number,
  maxEvents: number,
  include: (event: ContextEvent) => boolean,
): SelectedWindow => {
  const selected: ContextEvent[] = []
  let nextCursor = cursor
  while (nextCursor < snapshot.length && selected.length < maxEvents) {
    const event = snapshot[nextCursor]
    nextCursor++
    // A malformed store snapshot must not make the reader throw. Treat an
    // individual predicate failure as a non-match and continue so the cursor
    // cannot get permanently stuck on one hostile event.
    try {
      if (event !== undefined && include(event)) selected.push(event)
    } catch {
      // fail closed: omit this event while still consuming its index
    }
  }
  return { events: Object.freeze(selected), nextCursor }
}

/**
 * Create a cursor-owning reader over a typed-history event store.
 *
 * The cursor uses insertion index rather than event timestamps: `at` is not
 * required to be monotonic by the store contract, and timestamp cursors can
 * either duplicate same-millisecond events or lose clock-skewed ones.
 */
export const createContextEventStoreReader = (
  store: TypedHistoryEventStore,
  options: ContextEventStoreReaderOptions = {},
): ContextEventStoreReader => {
  const maxEvents = resolveMaxEvents(options.maxEvents)
  const include = options.include ?? (() => true)
  let cursor = 0

  return {
    read: (): readonly ContextEvent[] => {
      let snapshot: readonly ContextEvent[]
      try {
        snapshot = store.snapshot()
      } catch {
        return Object.freeze([])
      }

      // `clear()` is the only store operation allowed to shrink the sequence.
      // Resetting lets the next post-clear append surface once, without
      // replaying pre-clear history.
      if (snapshot.length < cursor) cursor = 0
      if (cursor >= snapshot.length) return Object.freeze([])

      const window = selectWindow(snapshot, cursor, maxEvents, include)
      cursor = window.nextCursor
      return window.events
    },
  }
}

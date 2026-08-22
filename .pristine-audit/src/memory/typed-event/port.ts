/**
 * ADR-0319 — `TypedHistoryEventStore` closed port.
 *
 * Sync, in-process, append-only side-channel store. Sits PARALLEL to
 * the wm message buffer (`src/memory/working.ts`); the wm is not
 * mutated and is not reachable from this slice.
 *
 * Closed-port DIP (slice-fence): every method below is contractual —
 * extending the surface requires a new ADR. The default adapter lives
 * in `./in-memory-store.ts`; alternate adapters (e.g. persistence,
 * cross-session) must satisfy the same shape without exposing impl
 * internals.
 *
 * Contract details:
 *  - `append` is total: the event is stored verbatim; no validation,
 *    no de-duplication. Producers are responsible for sane payloads.
 *  - `snapshot` returns a frozen array (mutation throws in strict
 *    mode). Insertion order = iteration order.
 *  - `since(at)` returns events whose `at >= at` (INCLUSIVE on the
 *    boundary). The inclusive lower bound is deliberate so a polling
 *    consumer can resume with the last seen timestamp without losing
 *    same-millisecond events.
 *  - `clear` drops every event. Intended for session boundaries; the
 *    contract does NOT persist across `clear`.
 */

import type { TypedHistoryEvent } from "./types"

export interface TypedHistoryEventStore {
  /** Append `event` verbatim. O(1) amortized. No validation. */
  append(event: TypedHistoryEvent): void
  /** Frozen view of all events in insertion order. */
  snapshot(): readonly TypedHistoryEvent[]
  /** Frozen view of events whose `at >= at` (boundary INCLUSIVE). */
  since(at: number): readonly TypedHistoryEvent[]
  /** Drop every event. Session-boundary reset. */
  clear(): void
}

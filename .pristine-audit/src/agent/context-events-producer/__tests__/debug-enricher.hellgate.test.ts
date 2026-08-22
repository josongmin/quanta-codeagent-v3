/**
 * ADR-0336 — typed-event → debug-sink CONSUMER hellgate.
 *
 * Seals that the typed-event store is NO LONGER a dead write-sink: events
 * appended by the producers surface through the EXISTING bench trajectory
 * debug-sink as `metadata.debug.typedEvents`.
 *
 * The test drives the REAL `debugSink` singleton (not a mock) so the wire
 * is genuine end-to-end: `store.append(...)` → `debugSink.register(enricher)`
 * → `debugSink.drain()` returns the events under the `typedEvents` key.
 *
 * Cases:
 *   A. Genuine surface — appended events appear in drain under the key.
 *   B. Incremental — a second drain returns ONLY the newly-appended tail.
 *   C. Quiet turn — no new events ⇒ enricher contributes nothing (key absent).
 *   D. OFF byte-identical — gate off ⇒ drain returns undefined, sample never
 *      pollutes the record.
 *   E. NO-THROW — a throwing store degrades to "contribute nothing", cursor
 *      unadvanced (next drain retries).
 *   F. Red-on-injection guard — the enricher's sample() actually READS the
 *      store (removing the drain wire would make A/B fail).
 *   G. Count-cursor correctness — same-millisecond events all surface exactly
 *      once (timestamp cursor would double-count or drop them).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { debugSink, isTrajectoryDebugEnabled } from "@/apps/bench/trajectory-debug-sink"
import type { TypedHistoryEvent, TypedHistoryEventStore } from "@/memory/typed-event"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import { makeTypedEventDebugEnricher, TYPED_EVENTS_DEBUG_KEY } from "../debug-enricher"

const GATE = "QUANTA_BENCH_RECORD_TRAJECTORY"

const withGate = <T>(value: string | undefined, fn: () => T): T => {
  const prev = process.env[GATE]
  if (value === undefined) delete process.env[GATE]
  else process.env[GATE] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[GATE]
    else process.env[GATE] = prev
  }
}

const ctxUpdate = (at: number, next: string): TypedHistoryEvent => ({
  kind: "context_update",
  field: "cwd",
  prev: "/old",
  next,
  at,
})

afterEach(() => {
  debugSink.reset()
})

describe("makeTypedEventDebugEnricher — ADR-0336 consumer hellgate", () => {
  // -------- A. genuine surface ------------------------------------------
  test("A — appended events surface through the real debug-sink drain", () => {
    withGate("debug", () => {
      expect(isTrajectoryDebugEnabled()).toBe(true)
      const store = createInMemoryTypedHistoryEventStore()
      debugSink.register(makeTypedEventDebugEnricher(store))
      store.append(ctxUpdate(1_000, "/a"))
      store.append(ctxUpdate(1_001, "/b"))
      const drained = debugSink.drain()
      expect(drained).toBeDefined()
      const events = drained?.[TYPED_EVENTS_DEBUG_KEY] as readonly TypedHistoryEvent[]
      expect(events).toHaveLength(2)
      expect(events.map((e) => (e as { next: string }).next)).toEqual(["/a", "/b"])
    })
  })

  // -------- B. incremental drain ----------------------------------------
  test("B — second drain returns ONLY the newly-appended tail", () => {
    withGate("debug", () => {
      const store = createInMemoryTypedHistoryEventStore()
      debugSink.register(makeTypedEventDebugEnricher(store))
      store.append(ctxUpdate(1_000, "/a"))
      const first = debugSink.drain()?.[TYPED_EVENTS_DEBUG_KEY] as readonly TypedHistoryEvent[]
      expect(first).toHaveLength(1)
      store.append(ctxUpdate(2_000, "/b"))
      store.append(ctxUpdate(2_001, "/c"))
      const second = debugSink.drain()?.[TYPED_EVENTS_DEBUG_KEY] as readonly TypedHistoryEvent[]
      expect(second).toHaveLength(2)
      expect(second.map((e) => (e as { next: string }).next)).toEqual(["/b", "/c"])
    })
  })

  // -------- C. quiet turn -----------------------------------------------
  test("C — no new events ⇒ enricher contributes nothing (key absent)", () => {
    withGate("debug", () => {
      const store = createInMemoryTypedHistoryEventStore()
      debugSink.register(makeTypedEventDebugEnricher(store))
      // no appends at all — the ONLY registered enricher is quiet, so the
      // debug-sink omits the whole debug object.
      expect(debugSink.drain()).toBeUndefined()
      // append + drain, then a quiet second turn ⇒ key absent again.
      store.append(ctxUpdate(1_000, "/a"))
      expect(debugSink.drain()?.[TYPED_EVENTS_DEBUG_KEY]).toBeDefined()
      expect(debugSink.drain()).toBeUndefined()
    })
  })

  // -------- D. OFF byte-identical ----------------------------------------
  test("D — gate OFF ⇒ drain undefined even with appended events", () => {
    withGate(undefined, () => {
      expect(isTrajectoryDebugEnabled()).toBe(false)
      const store = createInMemoryTypedHistoryEventStore()
      debugSink.register(makeTypedEventDebugEnricher(store))
      store.append(ctxUpdate(1_000, "/a"))
      // off-gate: debug-sink drain is a no-op ⇒ undefined ⇒ record stays
      // byte-identical (no `debug` key ever written).
      expect(debugSink.drain()).toBeUndefined()
    })
  })

  // -------- E. NO-THROW --------------------------------------------------
  test("E — throwing store ⇒ sample contributes nothing, cursor unadvanced", () => {
    withGate("debug", () => {
      let boom = true
      const flaky: TypedHistoryEventStore = {
        append() {},
        snapshot() {
          if (boom) throw new Error("boom")
          return Object.freeze([ctxUpdate(1_000, "/a")])
        },
        since() {
          return Object.freeze([])
        },
        clear() {},
      }
      const enricher = makeTypedEventDebugEnricher(flaky)
      // Throwing snapshot ⇒ undefined (no throw escapes).
      expect(enricher.sample()).toBeUndefined()
      // Cursor unadvanced: once the store recovers, the event still surfaces.
      boom = false
      const recovered = enricher.sample()
      expect(recovered).toHaveLength(1)
    })
  })

  // -------- F. red-on-injection: sample genuinely reads the store --------
  test("F — sample() reads the store (drain wire is load-bearing)", () => {
    withGate("debug", () => {
      const store = createInMemoryTypedHistoryEventStore()
      const enricher = makeTypedEventDebugEnricher(store)
      // Before any append the read returns undefined (proves it reads live,
      // not a canned constant).
      expect(enricher.sample()).toBeUndefined()
      store.append(ctxUpdate(1_000, "/a"))
      // After append the SAME enricher instance now returns the event —
      // only possible if sample() actually calls store.snapshot().
      const got = enricher.sample()
      expect(got).toHaveLength(1)
      expect((got?.[0] as { next: string }).next).toBe("/a")
    })
  })

  // -------- G. count-cursor: same-millisecond events surface once --------
  test("G — same-millisecond events surface exactly once (count cursor)", () => {
    withGate("debug", () => {
      const store = createInMemoryTypedHistoryEventStore()
      const enricher = makeTypedEventDebugEnricher(store)
      store.append(ctxUpdate(5_000, "/a"))
      store.append(ctxUpdate(5_000, "/b")) // identical `at`
      const first = enricher.sample()
      expect(first).toHaveLength(2)
      // A second drain with no new appends: a timestamp cursor with
      // inclusive `since(at)` would RE-surface both 5_000 events; the count
      // cursor returns undefined (nothing new).
      expect(enricher.sample()).toBeUndefined()
      store.append(ctxUpdate(5_000, "/c")) // still same millisecond
      const third = enricher.sample()
      expect(third).toHaveLength(1)
      expect((third?.[0] as { next: string }).next).toBe("/c")
    })
  })
})

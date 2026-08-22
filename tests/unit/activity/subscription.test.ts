/**
 * RFC-04 (R6) D1 — activity subscription protocol hellgate (aug-22 absorption).
 *
 * The missing prerequisite that blocks D4: the landed store can `emit`/`snapshot`
 * but a live consumer cannot subscribe atomically. A consumer that does the
 * two-step `snap = store.snapshot(); store.onChange(listener)` LOSES any event
 * injected in the window between capture and registration. This packet adds a
 * store-level monotonic sequence + an ATOMIC `{snapshot, nextSeq}` subscription
 * (`store.subscribe` / `createActivitySubscription`) that closes that window, and
 * a bounded-coalescing delivery that preserves lifecycle order.
 *
 * Every assertion drives a REAL store (or a real coalescing subscription over a
 * controllable raw source) — never a single-literal assertion — and the
 * load-bearing rules carry red-on-injection / negative-control twins:
 *   NEG. naive snapshot-then-register LOSES the between-event (why atomic exists)
 *   A.   atomic {snapshot,nextSeq}: exact partition, no loss / no duplication
 *   B.   event emitted DURING snapshot capture is neither lost nor duplicated
 *   C.   monotonic gapless seq under interleaved emit
 *   D.   ordered lifecycle delivery (never reordered), progress coalesced
 *   E.   bounded coalescing collapses a same-node progress burst to the latest
 *   F.   unsubscribe stops delivery
 */

import { describe, expect, test } from "bun:test"
import {
  type ActivityChange,
  type ActivityEvent,
  type ActivityKind,
  type ActivityStatus,
  type RawActivitySource,
  createActivitySubscription,
  createActivityStore,
} from "@/activity"

// ── event builders ───────────────────────────────────────────────────────────
const open = (id: string, parentId: string | null = null, kind: ActivityKind = "operation"): ActivityEvent => ({
  type: "node_open",
  node: { id, parentId, kind, label: id },
})
const status = (id: string, s: ActivityStatus): ActivityEvent => ({ type: "node_status", id, status: s })
const prog = (id: string, completed: number, total: number): ActivityEvent => ({
  type: "node_progress",
  id,
  progress: { kind: "ratio", completed, total },
})

/** A deterministic scheduler: captures scheduled flushes so a test flushes on
 *  demand (coalescing needs batching — a synchronous per-emit flush cannot
 *  coalesce). Mirrors how the CLI would drive redraw on a frame boundary. */
const makeManual = (): { schedule: (f: () => void) => void; run: () => void } => {
  const q: Array<() => void> = []
  return {
    schedule: (f) => {
      q.push(f)
    },
    run: () => {
      const c = [...q]
      q.length = 0
      for (const f of c) f()
    },
  }
}

const idOf = (e: ActivityEvent): string | undefined =>
  e.type === "node_open" ? e.node.id : e.id

// ── NEG. negative control: the hazard the atomic API removes ─────────────────
describe("D1 · negative control (the race is real)", () => {
  test("naive snapshot-then-register LOSES the between-event", () => {
    const store = createActivityStore()
    store.emit(open("a"))
    const snap = store.snapshot() // consumer captures the initial view …
    store.emit(open("b")) // … an event lands in the un-covered window …
    const m = makeManual()
    const delivered: ActivityChange[] = []
    store.subscribe((c) => delivered.push(c), { schedule: m.schedule }) // … then registers
    store.emit(open("c"))
    m.run()
    // b is in NEITHER the captured snapshot NOR the delivered stream → LOST.
    expect(snap.byId.has("b")).toBe(false)
    expect(delivered.some((c) => idOf(c.event) === "b")).toBe(false)
  })
})

// ── A. atomic partition ───────────────────────────────────────────────────────
describe("D1 · atomic {snapshot, nextSeq}", () => {
  test("exact partition across the subscribe edge — no loss, no duplication", () => {
    const store = createActivityStore()
    store.emit(open("a"))
    store.emit(open("b"))
    const m = makeManual()
    const delivered: ActivityChange[] = []
    const sub = store.subscribe((c) => delivered.push(c), { schedule: m.schedule })
    // everything with seq < nextSeq is in the snapshot …
    expect(sub.snapshot.byId.has("a")).toBe(true)
    expect(sub.snapshot.byId.has("b")).toBe(true)
    expect(sub.snapshot.byId.has("c")).toBe(false)
    expect(sub.nextSeq).toBe(3) // seq 1,2 captured; next future event is 3
    // … everything with seq >= nextSeq is delivered, exactly once.
    store.emit(open("c"))
    m.run()
    expect(delivered.map((c) => c.seq)).toEqual([3])
    expect(delivered.map((c) => idOf(c.event))).toEqual(["c"]) // a,b never re-delivered
  })
})

// ── B. during-capture injection (drives the atomic attach directly) ──────────
describe("D1 · event emitted during snapshot capture", () => {
  test("is neither lost nor duplicated (attach registers before capturing seq)", () => {
    // A raw source that delivers an event to the just-registered raw listener
    // DURING attach, and reports it as ALSO reflected in the returned snapshot
    // (seq <= returned seq). The subscription must drop it (already in snapshot)
    // yet still deliver a genuinely-later event.
    const snapStore = createActivityStore()
    snapStore.emit(open("x"))
    const holder: { raw: ((c: ActivityChange) => void) | null } = { raw: null }
    const src: RawActivitySource = {
      attach(raw) {
        holder.raw = raw
        raw({ seq: 5, event: open("x") }) // arrives mid-capture, seq 5
        return { snapshot: snapStore.snapshot(), seq: 5, detach: () => {} }
      },
    }
    const m = makeManual()
    const delivered: ActivityChange[] = []
    const sub = createActivitySubscription(src, (c) => delivered.push(c), { schedule: m.schedule })
    m.run()
    expect(sub.snapshot.byId.has("x")).toBe(true) // no loss — x is in the snapshot
    expect(delivered.length).toBe(0) // no duplication — x not also delivered
    // a genuinely-after event (seq > baseSeq) IS delivered.
    holder.raw?.({ seq: 6, event: open("y") })
    m.run()
    expect(delivered.map((c) => c.seq)).toEqual([6])
  })
})

// ── C. monotonic gapless seq ─────────────────────────────────────────────────
describe("D1 · monotonic sequence", () => {
  test("gapless + ordered under interleaved emit", () => {
    const store = createActivityStore()
    const m = makeManual()
    const seen: number[] = []
    const sub = store.subscribe((c) => seen.push(c.seq), { schedule: m.schedule })
    const base = sub.nextSeq
    for (let i = 0; i < 20; i++) store.emit(open(`n${i}`))
    m.run()
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => base + i))
    expect(store.seq).toBe(base - 1 + 20) // store counter kept exact
  })
})

// ── D. ordered lifecycle delivery (never reordered by coalescing) ────────────
describe("D1 · ordered lifecycle delivery", () => {
  test("lifecycle transitions preserve order; progress does not jump a lifecycle", () => {
    const store = createActivityStore()
    store.emit(open("op", null, "operation"))
    const m = makeManual()
    const seen: ActivityChange[] = []
    store.subscribe((c) => seen.push(c), { schedule: m.schedule })
    store.emit(open("s1", "op", "step"))
    store.emit(prog("s1", 1, 10))
    store.emit(status("s1", "done")) // seals s1's progress slot
    store.emit(open("s2", "op", "step"))
    store.emit(prog("s1", 5, 10)) // late — must NOT coalesce back before `done`
    m.run()
    const lifecycle = seen
      .filter((c) => c.event.type !== "node_progress")
      .map((c) => `${c.event.type}:${idOf(c.event)}`)
    expect(lifecycle).toEqual(["node_open:s1", "node_status:s1", "node_open:s2"])
    // two distinct progress slots survive (the seal prevented cross-lifecycle merge)
    const progVals = seen
      .filter((c) => c.event.type === "node_progress")
      .map((c) => (c.event.type === "node_progress" && c.event.progress.kind === "ratio" ? c.event.progress.completed : -1))
    expect(progVals).toEqual([1, 5])
  })
})

// ── E. bounded coalescing ─────────────────────────────────────────────────────
describe("D1 · bounded coalescing", () => {
  test("a same-node progress burst collapses to the latest", () => {
    const store = createActivityStore()
    store.emit(open("chk", null, "step"))
    const m = makeManual()
    const seen: ActivityChange[] = []
    store.subscribe((c) => seen.push(c), { schedule: m.schedule })
    store.emit(prog("chk", 1, 10))
    store.emit(prog("chk", 4, 10))
    store.emit(prog("chk", 9, 10))
    m.run()
    const progEvents = seen.filter((c) => c.event.type === "node_progress")
    expect(progEvents.length).toBe(1) // coalesced to one
    const only = progEvents[0]?.event
    expect(only?.type === "node_progress" && only.progress).toEqual({ kind: "ratio", completed: 9, total: 10 })
  })

  test("distinct nodes each keep their own coalesced slot (order preserved)", () => {
    const store = createActivityStore()
    store.emit(open("a", null, "step"))
    store.emit(open("b", null, "step"))
    const m = makeManual()
    const seen: ActivityChange[] = []
    store.subscribe((c) => seen.push(c), { schedule: m.schedule })
    store.emit(prog("a", 1, 10))
    store.emit(prog("b", 2, 10))
    store.emit(prog("a", 8, 10))
    m.run()
    const progIds = seen.filter((c) => c.event.type === "node_progress").map((c) => idOf(c.event))
    expect(progIds).toEqual(["a", "b"]) // a coalesced in place; b kept; two total
  })
})

// ── F. unsubscribe ────────────────────────────────────────────────────────────
describe("D1 · unsubscribe", () => {
  test("unsubscribe stops delivery", () => {
    const store = createActivityStore()
    const m = makeManual()
    const seen: ActivityChange[] = []
    const sub = store.subscribe((c) => seen.push(c), { schedule: m.schedule })
    store.emit(open("a"))
    m.run()
    expect(seen.length).toBe(1)
    sub.unsubscribe()
    store.emit(open("b"))
    m.run()
    expect(seen.length).toBe(1) // no further delivery
  })
})

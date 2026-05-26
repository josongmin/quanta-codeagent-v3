/**
 * ADR-0329 — `createContextEventsProducer` hellgate.
 *
 * Seals the closure factory contract — 14 cases covering:
 *
 *   A. First-call baseline                      (1)
 *   B. No-change steady state                   (1)
 *   C. Single-field diff (cwd)                  (1)
 *   D. Multi-field diff                         (1)
 *   E. NO-THROW (getSnapshot/append/since)      (3)
 *   F. Cursor accuracy across calls             (1)
 *   G. Same-millisecond inclusive boundary      (1)
 *   H. Deterministic clock injection            (1)
 *   I. sessionId/turnId composition             (2)
 *   J. Skill activation system trigger          (1)
 *   K. mode change ⇒ mode_change emission       (1)
 */

import { describe, expect, test } from "bun:test"
import type { TypedHistoryEvent, TypedHistoryEventStore } from "@/memory/typed-event"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import { createContextEventsProducer } from "../factory"
import type { ContextSnapshotInput } from "../types"

const baseInput = (over: Partial<ContextSnapshotInput> = {}): ContextSnapshotInput => ({
  cwd: "/repo",
  mode: "default",
  model: "gpt-5",
  repoRulesPaths: ["AGENTS.md"],
  activeSkills: [],
  ...over,
})

const makeClock = (...values: number[]): (() => number) => {
  let i = 0
  return () => {
    const v = values[i] ?? values[values.length - 1] ?? 0
    i += 1
    return v
  }
}

describe("createContextEventsProducer — ADR-0329 hellgate", () => {
  // -------- A. first-call baseline --------------------------------------

  test("A1 — first call captures baseline and returns []", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput()
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000),
    })
    expect(producer()).toEqual([])
    expect(store.snapshot()).toEqual([])
    // Confirm baseline is held — second call with same snapshot ⇒ []
    input = baseInput()
    expect(producer()).toEqual([])
  })

  // -------- B. no-change steady state -----------------------------------

  test("B1 — repeated identical snapshot ⇒ [] every time", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => baseInput(),
      now: makeClock(1_000, 2_000, 3_000),
    })
    producer() // baseline
    expect(producer()).toEqual([])
    expect(producer()).toEqual([])
    expect(store.snapshot()).toEqual([])
  })

  // -------- C. single-field diff (cwd) ----------------------------------

  test("C1 — cwd flip emits exactly one context_update and is returned", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/old" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      sessionId: "S1",
      now: makeClock(1_000, 2_000),
    })
    producer() // baseline at t=1000
    input = baseInput({ cwd: "/new" })
    const out = producer()
    expect(out).toHaveLength(1)
    const e = out[0] as TypedHistoryEvent
    expect(e.kind).toBe("context_update")
    if (e.kind === "context_update") {
      expect(e.field).toBe("cwd")
      expect(e.prev).toBe("/old")
      expect(e.next).toBe("/new")
      expect(e.at).toBe(2_000)
      expect(e.turnId).toBe("S1:t1")
    }
    expect(store.snapshot()).toHaveLength(1)
  })

  // -------- D. multi-field diff -----------------------------------------

  test("D1 — multi-field flip emits N events (cwd + model + mode_change)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a", mode: "default", model: "gpt-5" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ cwd: "/b", mode: "architect", model: "claude-4-7" })
    const out = producer()
    expect(out).toHaveLength(3)
    const kinds = out.map((e) => e.kind).sort()
    expect(kinds).toEqual(["context_update", "context_update", "mode_change"])
  })

  // -------- E. NO-THROW invariants --------------------------------------

  test("E1 — getSnapshot throws ⇒ [] and prev/cursor unchanged", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let mode = "default"
    let shouldThrow = false
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => {
        if (shouldThrow) throw new Error("snapshot fail")
        return baseInput({ mode })
      },
      now: makeClock(1_000, 2_000, 3_000),
    })
    producer() // baseline mode=default
    shouldThrow = true
    expect(producer()).toEqual([])
    expect(store.snapshot()).toEqual([])
    // Recover: next non-throwing call diffs against the ORIGINAL baseline.
    shouldThrow = false
    mode = "architect"
    const out = producer()
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("mode_change")
  })

  test("E2 — store.append throws ⇒ [] and prev unchanged (atomicity)", () => {
    const real = createInMemoryTypedHistoryEventStore()
    let appendShouldThrow = true
    const store: TypedHistoryEventStore = {
      append: (e) => {
        if (appendShouldThrow) throw new Error("append fail")
        real.append(e)
      },
      snapshot: () => real.snapshot(),
      since: (at) => real.since(at),
      clear: () => real.clear(),
    }
    let input = baseInput({ cwd: "/old" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000, 3_000),
    })
    producer() // baseline at /old
    input = baseInput({ cwd: "/new" })
    expect(producer()).toEqual([])
    expect(real.snapshot()).toEqual([])

    // Atomicity proof: prev is STILL /old (not /new) — so when the append
    // path recovers, the SAME /old → /new diff fires.
    appendShouldThrow = false
    const out = producer()
    expect(out).toHaveLength(1)
    expect((out[0] as { prev?: unknown; next?: unknown }).prev).toBe("/old")
    expect((out[0] as { prev?: unknown; next?: unknown }).next).toBe("/new")
  })

  test("E3 — store.since throws ⇒ [] (events still appended)", () => {
    const real = createInMemoryTypedHistoryEventStore()
    const store: TypedHistoryEventStore = {
      append: (e) => real.append(e),
      snapshot: () => real.snapshot(),
      since: () => {
        throw new Error("since fail")
      },
      clear: () => real.clear(),
    }
    let input = baseInput({ cwd: "/old" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ cwd: "/new" })
    expect(producer()).toEqual([])
    // Append half DID succeed — the underlying store has the event.
    expect(real.snapshot()).toHaveLength(1)
  })

  // -------- F. cursor accuracy -----------------------------------------

  test("F1 — second-turn since returns ONLY new events (lastTurnAt cursor advances)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000, 3_000),
    })
    producer() // baseline at 1000

    input = baseInput({ cwd: "/b" })
    const turn2 = producer() // at=2000, cursor was 1000 ⇒ since(1000) returns the new event
    expect(turn2).toHaveLength(1)

    input = baseInput({ cwd: "/c" })
    const turn3 = producer() // at=3000, cursor was 2000 ⇒ since(2000)
    expect(turn3).toHaveLength(1) // ONLY the /b → /c event, not the prior one
    expect((turn3[0] as { next?: unknown }).next).toBe("/c")
  })

  // -------- G. within-turn same-ms boundary -----------------------------

  test("G1 — multiple events emitted at the same `at` within one turn all surface together", () => {
    // ALL detector events for a single turn share that turn's `at`. The
    // cursor was set BEFORE this turn's events were appended, so the
    // inclusive since() lower bound captures every same-ms event exactly
    // once on THIS turn's return.
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a", mode: "default", model: "m1" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ cwd: "/b", mode: "editor", model: "m2" })
    const out = producer()
    expect(out).toHaveLength(3)
    // All three events stamp the same wall-clock — the detector uses ONE
    // `at` per turn regardless of how many fields flipped.
    const ats = out.map((e) => (e as { at: number }).at)
    expect(new Set(ats).size).toBe(1)
    expect(ats[0]).toBe(2_000)
  })

  // -------- H. deterministic clock --------------------------------------

  test("H1 — injected now() is the ONLY clock source (no Date.now reads)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a" })
    let calls = 0
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: () => {
        calls += 1
        return 42_000 + calls
      },
    })
    producer()
    input = baseInput({ cwd: "/b" })
    const out = producer()
    expect(out).toHaveLength(1)
    expect((out[0] as { at: number }).at).toBe(42_002)
    expect(calls).toBe(2)
  })

  // -------- I. sessionId / turnId composition ---------------------------

  test("I1 — sessionId absent ⇒ turnId = 't1', 't2', ...", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000, 3_000),
    })
    producer()
    input = baseInput({ cwd: "/b" })
    const turn2 = producer()
    expect((turn2[0] as { turnId?: string }).turnId).toBe("t1")
    input = baseInput({ cwd: "/c" })
    const turn3 = producer()
    // Find the event introduced on turn3 (since is inclusive)
    const t3New = turn3.find((e) => (e as { next?: unknown }).next === "/c")
    expect((t3New as { turnId?: string } | undefined)?.turnId).toBe("t2")
  })

  test("I2 — sessionId present ⇒ turnId combines sessionId:t-counter", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ cwd: "/a" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      sessionId: "sess-abc",
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ cwd: "/b" })
    const turn2 = producer()
    expect((turn2[0] as { turnId?: string }).turnId).toBe("sess-abc:t1")
  })

  // -------- J. skill activation -----------------------------------------

  test("J1 — adding an active skill emits skill_activation with trigger='system'", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ activeSkills: [] })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ activeSkills: ["progress-audit"] })
    const out = producer()
    expect(out).toHaveLength(1)
    const e = out[0] as TypedHistoryEvent
    expect(e.kind).toBe("skill_activation")
    if (e.kind === "skill_activation") {
      expect(e.skillId).toBe("progress-audit")
      expect(e.trigger).toBe("system")
    }
  })

  // -------- K. mode change ----------------------------------------------

  test("K1 — mode flip emits mode_change (not context_update)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    let input = baseInput({ mode: "default" })
    const producer = createContextEventsProducer({
      store,
      getSnapshot: () => input,
      now: makeClock(1_000, 2_000),
    })
    producer()
    input = baseInput({ mode: "architect" })
    const out = producer()
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("mode_change")
  })
})

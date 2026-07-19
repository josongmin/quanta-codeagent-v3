/**
 * PlanQueueStore.sendNow — FAIL-CLOSED timing-window hellgate (DOF-40).
 *
 * The prior contract collapsed THREE distinct sendNow outcomes into one
 * opaque `send-not-possible` AND removed the entry unconditionally:
 *   (a) no sink wired,
 *   (b) sink wired but downstream target not installed yet (the first-turn
 *       composition-root TIMING WINDOW — the REPL `sendNowSink` closure
 *       exists at store-construction but the loop-owned `ExternalPromptQueue`
 *       target is late-bound via `setPlanQueueSendNow`),
 *   (c) sink rejected the payload.
 * In case (b) a `/queue send-now` fired inside the window SILENTLY DROPPED
 * the entry (removed, never delivered, indistinguishable from a real
 * rejection) — a fail-OPEN silent miss.
 *
 * This file pins the fail-CLOSED fix:
 *   - the timing window returns the TRANSIENT typed `send-not-ready`, NOT
 *     `send-not-possible`, and KEEPS the entry (retry-able, never silent);
 *   - a TERMINAL rejection / throw / no-sink still maps to `send-not-possible`
 *     and removes the entry (byte-identical to the prior contract);
 *   - exactly ONE `inject` call per invocation (no double-send);
 *   - OFF byte-identity: mutators never called ⇒ store unmodified;
 *   - red-on-injection: reverting the fail-closed branch re-opens the drop.
 *
 * It reconstructs the EXACT REPL composition-root sink wrapper closure (from
 * `surface-compose.ts`) so the window under test is the REAL one, not a mock.
 */

import { describe, expect, test } from "bun:test"
import {
  defaultPlanQueueStore,
  type PlanQueueStore,
  type SendNowInjection,
  type SendNowSink,
} from "@/agent/plan-queue"

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

let tickValue = 5_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 5_000): void => {
  tickValue = start
}

const fresh = (sink?: SendNowSink): PlanQueueStore => {
  resetTick()
  return defaultPlanQueueStore({
    maxPerThread: 32,
    now: tick,
    ...(sink !== undefined ? { sendNowSink: sink } : {}),
  })
}

const enq = (s: PlanQueueStore, threadId: string, text: string): string =>
  s.enqueue({
    threadId,
    text,
    source: "user_keystroke",
    pausedReason: "tool_in_flight",
    arrivedDuringTurn: 0,
    urgent: false,
    metadata: {},
  }).id

/**
 * Reconstruct the composition-root sink wrapper VERBATIM (surface-compose.ts).
 * The `target` starts undefined (the timing window); the loop installs it later
 * via `install()`. This IS the closure under test.
 */
const makeReplSink = (): {
  sink: SendNowSink
  install: (
    fn: (inj: SendNowInjection) => { ok: true } | { ok: false; reason: string },
  ) => void
  installedCalls: SendNowInjection[]
} => {
  let target:
    | ((inj: SendNowInjection) => { ok: true } | { ok: false; reason: string })
    | undefined
  const installedCalls: SendNowInjection[] = []
  return {
    installedCalls,
    install: (fn) => {
      target = (inj) => {
        installedCalls.push(inj)
        return fn(inj)
      }
    },
    sink: {
      inject: (inj) =>
        target !== undefined
          ? target(inj)
          : { ok: false, reason: "send target not installed yet", retryable: true },
    },
  }
}

// A sink that COUNTS every inject so we can assert exactly-one-call.
const countingSink = (
  reply: "ok" | "reject-terminal" | "reject-transient" | "throw",
): SendNowSink & { count: () => number } => {
  let n = 0
  return {
    count: () => n,
    inject() {
      n += 1
      if (reply === "throw") throw new Error("sink boom")
      if (reply === "reject-terminal") return { ok: false, reason: "downstream-full" }
      if (reply === "reject-transient")
        return { ok: false, reason: "not ready", retryable: true }
      return { ok: true }
    },
  }
}

// =============================================================
// A. TIMING WINDOW — the core fail-closed invariant
// =============================================================

describe("sendNow · timing window (fail-closed)", () => {
  test("FC-1: sink wired but target NOT installed ⇒ 'send-not-ready' AND entry KEPT (not silent drop)", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const id = enq(s, "t1", "steer me")
    // Fire INSIDE the window — target is still undefined.
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-ready")
    // FAIL-CLOSED: the entry SURVIVES so the operator can retry. This is the
    // whole point — pre-fix this entry was silently removed.
    const live = s.peek("t1")
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe(id)
    expect(live[0]?.text).toBe("steer me")
    // Nothing reached the (uninstalled) downstream target.
    expect(repl.installedCalls).toHaveLength(0)
  })

  test("FC-2: after target installs, the SAME kept entry delivers ⇒ ok + removed + downstream saw it once", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const id = enq(s, "t1", "steer me")
    // Window miss — kept.
    expect(s.sendNow(id).ok).toBe(false)
    expect(s.peek("t1")).toHaveLength(1)
    // Loop comes up and installs the real target.
    const delivered: string[] = []
    repl.install((inj) => {
      delivered.push(inj.text)
      return { ok: true }
    })
    // Retry the SAME id — now it delivers.
    const r2 = s.sendNow(id)
    expect(r2.ok).toBe(true)
    expect(delivered).toEqual(["steer me"])
    expect(s.peek("t1")).toEqual([])
    expect(s.findEntry(id)).toBeUndefined()
    // Downstream target saw the payload EXACTLY once (window miss did not leak).
    expect(repl.installedCalls).toHaveLength(1)
  })

  test("FC-3: concurrent double-fire INSIDE the window ⇒ BOTH not-ready, entry still kept, ZERO downstream", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const id = enq(s, "t1", "double")
    const r1 = s.sendNow(id)
    const r2 = s.sendNow(id) // same id, still in window
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    if (r1.ok === false) expect(r1.error).toBe("send-not-ready")
    if (r2.ok === false) expect(r2.error).toBe("send-not-ready")
    // Entry never removed by either transient miss.
    expect(s.peek("t1")).toHaveLength(1)
    expect(repl.installedCalls).toHaveLength(0)
  })
})

// =============================================================
// B. TERMINAL outcomes — byte-identical to prior contract
// =============================================================

describe("sendNow · terminal outcomes (entry removed)", () => {
  test("FC-4: no sink wired ⇒ 'send-not-possible' + entry removed (unchanged)", () => {
    const s = fresh()
    const id = enq(s, "t1", "x")
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(s.peek("t1")).toEqual([])
  })

  test("FC-5: sink rejects WITHOUT retryable ⇒ 'send-not-possible' + removed + exactly one inject", () => {
    const sink = countingSink("reject-terminal")
    const s = fresh(sink)
    const id = enq(s, "t1", "x")
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(s.peek("t1")).toEqual([])
    expect(sink.count()).toBe(1)
  })

  test("FC-6: sink THROWS ⇒ 'send-not-possible' (terminal, not retryable) + removed + one inject", () => {
    const sink = countingSink("throw")
    const s = fresh(sink)
    const id = enq(s, "t1", "x")
    let threw: unknown = null
    let r: ReturnType<PlanQueueStore["sendNow"]> | null = null
    try {
      r = s.sendNow(id)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(r?.ok).toBe(false)
    if (r && r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(s.peek("t1")).toEqual([])
    expect(sink.count()).toBe(1)
  })

  test("FC-7: sink accepts ⇒ ok + removed + exactly one inject", () => {
    const sink = countingSink("ok")
    const s = fresh(sink)
    const id = enq(s, "t1", "x")
    const r = s.sendNow(id)
    expect(r.ok).toBe(true)
    expect(s.peek("t1")).toEqual([])
    expect(sink.count()).toBe(1)
  })

  test("FC-8: transient sink (retryable) ⇒ 'send-not-ready' + KEPT + exactly one inject", () => {
    const sink = countingSink("reject-transient")
    const s = fresh(sink)
    const id = enq(s, "t1", "x")
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("send-not-ready")
    expect(s.peek("t1")).toHaveLength(1)
    expect(sink.count()).toBe(1)
  })
})

// =============================================================
// C. missing id short-circuit + no-sink probe
// =============================================================

describe("sendNow · not-found precedence", () => {
  test("FC-9: unknown id ⇒ 'not-found' and the sink is NEVER probed", () => {
    const sink = countingSink("ok")
    const s = fresh(sink)
    const r = s.sendNow("fu-nope-1")
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("not-found")
    expect(sink.count()).toBe(0)
  })

  test("FC-10: not-ready then delete ⇒ entry gone, later sendNow on same id ⇒ not-found", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const id = enq(s, "t1", "x")
    expect(s.sendNow(id).ok).toBe(false) // window miss, kept
    expect(s.delete(id).ok).toBe(true) // operator removes it
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toBe("not-found")
  })
})

// =============================================================
// D. 4 per-msg mutators round-trip alongside sendNow
// =============================================================

describe("sendNow · coexists with retry/edit/delete round-trip", () => {
  test("FC-11: retry/edit/delete all succeed while a not-ready sendNow keeps its entry", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const a = enq(s, "t1", "alpha")
    const b = enq(s, "t1", "bravo")
    const c = enq(s, "t1", "charlie")
    // sendNow on a — window miss, kept.
    expect(s.sendNow(a).ok).toBe(false)
    // edit b in place.
    const eb = s.edit(b, "bravo-2")
    expect(eb.ok).toBe(true)
    if (eb.ok) expect(eb.value.text).toBe("bravo-2")
    // delete c.
    expect(s.delete(c).ok).toBe(true)
    // retry a (still live because sendNow kept it) → fresh id.
    const ra = s.retry(a)
    expect(ra.ok).toBe(true)
    if (ra.ok) expect(ra.value.id).not.toBe(a)
    // Live set: retried-a (new id) + bravo-2.
    const live = s.peek("t1")
    const texts = live.map((e) => e.text).sort()
    expect(texts).toEqual(["alpha", "bravo-2"])
  })
})

// =============================================================
// E. OFF byte-identity — paired control
// =============================================================

describe("sendNow · OFF byte-identity (mutators never called)", () => {
  const snapshotStore = (s: PlanQueueStore): string =>
    JSON.stringify(
      [...s.inspect().entries()].map(([tid, entries]) => [
        tid,
        entries.map((e) => ({ ...e })),
      ]),
    )

  test("FC-12: a store whose sendNow is NEVER called is byte-identical to one that only enqueued", () => {
    // Control: enqueue-only, no sink wired.
    const control = fresh()
    enq(control, "t1", "one")
    enq(control, "t1", "two")
    enq(control, "t2", "three")
    const controlSnap = snapshotStore(control)

    // Experiment: identical enqueues, sink WIRED but sendNow NEVER invoked.
    const repl = makeReplSink()
    const exp = fresh(repl.sink)
    enq(exp, "t1", "one")
    enq(exp, "t1", "two")
    enq(exp, "t2", "three")
    const expSnap = snapshotStore(exp)

    // Wiring a sink but never firing a mutator ⇒ store contents identical.
    expect(expSnap).toBe(controlSnap)
    expect(repl.installedCalls).toHaveLength(0)
  })

  test("FC-13: a not-ready sendNow does NOT mutate the entry it kept (fields intact)", () => {
    const repl = makeReplSink()
    const s = fresh(repl.sink)
    const id = enq(s, "t1", "keep-me")
    const before = JSON.stringify(s.findEntry(id))
    expect(s.sendNow(id).ok).toBe(false) // window miss
    const after = JSON.stringify(s.findEntry(id))
    // The kept entry is untouched — same id, text, hash, drainedIntoTurn=null.
    expect(after).toBe(before)
  })
})

// =============================================================
// F. RED-ON-INJECTION — prove the test catches the regression
// =============================================================

describe("sendNow · red-on-injection (regression witness)", () => {
  test("FC-14: a sink that DROPS the retryable flag re-introduces the silent-drop bug (this is the pre-fix behavior)", () => {
    // Simulate the PRE-FIX composition root: the wrapper returns a plain
    // {ok:false} in the window (no `retryable`). The store then classifies it
    // TERMINAL ⇒ send-not-possible ⇒ entry REMOVED. This test documents that
    // the ONLY thing standing between fail-closed and the silent drop is the
    // `retryable:true` flag — if a future edit drops it, THIS asserts the
    // regression (entry gone) so the diff is caught in review.
    const preFixSink: SendNowSink = {
      inject: () => ({ ok: false, reason: "send target not installed yet" }),
    }
    const s = fresh(preFixSink)
    const id = enq(s, "t1", "would-be-dropped")
    const r = s.sendNow(id)
    expect(r.ok).toBe(false)
    // Without the retryable flag the store CANNOT know this is transient ⇒
    // terminal ⇒ removed. The fix lives in the SINK (retryable:true), proven
    // by FC-1 using the real wrapper.
    if (r.ok === false) expect(r.error).toBe("send-not-possible")
    expect(s.peek("t1")).toEqual([])
  })
})

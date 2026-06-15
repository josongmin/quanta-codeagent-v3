/**
 * jun-6 tool-interrupt-behavior — HELLGATE for the PURE interrupt-router state
 * machine (`makeInterruptRouter`, `src/tool/critical-section.ts`). Adversarial /
 * edge cases via an INJECTED fake clock + scheduler (deterministic, no real
 * timers). Covers RFC §6 cases 1–4, 6, 7.
 *
 * The fake "dispatch harness" mirrors how the `@/agent` composition root will
 * wrap a `"block"` tool: it constructs the derived controller, threads
 * `derived.signal` as the tool's `ctx.signal`, and `router.seam` as
 * `ctx.criticalSection`. The tests then drive an upstream abort + section
 * begin/end and assert the abort routing.
 */
import { describe, expect, test } from "bun:test"
import {
  type CriticalSectionScheduler,
  type InterruptRouterObserver,
  makeInterruptRouter,
} from "@/tool"

/** Deterministic fake clock + one-shot scheduler. `advance(ms)` moves the clock
 *  and fires every armed timer whose deadline has elapsed (in arm order). */
const makeFakeTime = () => {
  let nowMs = 0
  let seq = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const scheduler: CriticalSectionScheduler = {
    schedule(ms, cb) {
      const id = seq++
      timers.set(id, { at: nowMs + ms, cb })
      return () => {
        timers.delete(id)
      }
    },
  }
  const advance = (ms: number): void => {
    nowMs += ms
    // Fire due timers in arm order; collect first to avoid mutation-during-iter.
    const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs)
    for (const [id, t] of due) {
      timers.delete(id)
      t.cb()
    }
  }
  return { now: () => nowMs, scheduler, advance, pending: () => timers.size }
}

const MAX_MS = 50

const setup = (opts?: { observer?: InterruptRouterObserver; preAborted?: boolean }) => {
  const time = makeFakeTime()
  const source = new AbortController()
  if (opts?.preAborted) source.abort(new Error("pre"))
  const derived = new AbortController()
  const router = makeInterruptRouter({
    source: source.signal,
    derived,
    now: time.now,
    maxMs: MAX_MS,
    scheduler: time.scheduler,
    ...(opts?.observer ? { observer: opts.observer } : {}),
  })
  return { time, source, derived, router }
}

describe("interrupt-router: default cancel path (byte-identical)", () => {
  test("§6.1 abort with NO section open propagates to derived immediately", () => {
    const { source, derived, router } = setup()
    expect(derived.signal.aborted).toBe(false)
    source.abort(new Error("esc"))
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("§6.1 pre-aborted source mirrors eagerly (no hang)", () => {
    const { derived, router } = setup({ preAborted: true })
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("derived carries the source's abort reason", () => {
    const { source, derived, router } = setup()
    const reason = new Error("turn-cancelled")
    source.abort(reason)
    expect(derived.signal.reason).toBe(reason)
    router.dispose()
  })
})

describe("interrupt-router: block defers across the section ONLY", () => {
  test("§6.2 abort DURING a section is withheld, then delivered on end()", () => {
    const { source, derived, router } = setup()
    const cs = router.seam.begin()
    source.abort(new Error("esc")) // fires mid-section
    expect(derived.signal.aborted).toBe(false) // withheld
    cs.end()
    expect(derived.signal.aborted).toBe(true) // honored synchronously at end()
    router.dispose()
  })

  test("§6.3 abort BEFORE begin() is honored immediately (not a turn-wide hold)", () => {
    const { source, derived, router } = setup()
    source.abort(new Error("esc"))
    expect(derived.signal.aborted).toBe(true)
    // begin after-the-fact must not un-abort anything
    const cs = router.seam.begin()
    cs.end()
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("§6.3 abort AFTER end() is honored immediately (window already closed)", () => {
    const { source, derived, router } = setup()
    const cs = router.seam.begin()
    cs.end()
    expect(derived.signal.aborted).toBe(false)
    source.abort(new Error("esc"))
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("no abort at all ⇒ section open/close is a clean no-op", () => {
    const { derived, router } = setup()
    const cs = router.seam.begin()
    cs.end()
    expect(derived.signal.aborted).toBe(false)
    router.dispose()
  })
})

describe("interrupt-router: watchdog cap (can NEVER swallow a cancel)", () => {
  test("§6.4 a section that never ends ⇒ withheld abort force-delivered at the cap", () => {
    const { time, source, derived, router } = setup()
    router.seam.begin() // never ended (pathological tool)
    source.abort(new Error("esc"))
    expect(derived.signal.aborted).toBe(false) // withheld
    time.advance(MAX_MS - 1)
    expect(derived.signal.aborted).toBe(false) // still within the cap
    time.advance(1) // hit the deadline
    expect(derived.signal.aborted).toBe(true) // force-delivered
    router.dispose()
  })

  test("watchdog does NOT interrupt an abort-free section (cap bounds only a WITHHELD cancel)", () => {
    const { time, derived, router } = setup()
    router.seam.begin() // open, but source never aborts
    time.advance(MAX_MS * 10)
    expect(derived.signal.aborted).toBe(false)
    router.dispose()
  })

  test("end() before the cap cancels the watchdog (no double delivery)", () => {
    const { time, source, derived, router } = setup()
    const cs = router.seam.begin()
    source.abort(new Error("esc"))
    cs.end()
    expect(derived.signal.aborted).toBe(true)
    // advancing past the cap must not throw / re-deliver
    expect(() => time.advance(MAX_MS * 2)).not.toThrow()
    expect(time.pending()).toBe(0)
    router.dispose()
  })

  test("WATCHDOG-SWALLOW (regression): abort captured AFTER the window-open watchdog already expired is STILL bounded", () => {
    // The defect: the cap was computed from window-OPEN. An abort-free section
    // that runs past `maxMs` fires + disarms the window-open watchdog with
    // nothing to deliver; a LATER mid-section abort then has no live timer and
    // (pre-fix) was withheld FOREVER. The cap must bound the WITHHELD duration —
    // i.e. start ticking when the abort is CAPTURED.
    const { time, source, derived, router } = setup()
    router.seam.begin() // never ends (pathological tool)
    time.advance(MAX_MS) // abort-free past the window-open deadline
    expect(derived.signal.aborted).toBe(false)
    source.abort(new Error("late esc")) // captured now; a FRESH cap must arm
    expect(derived.signal.aborted).toBe(false) // withheld (section still open)
    time.advance(MAX_MS - 1)
    expect(derived.signal.aborted).toBe(false) // within the fresh cap
    time.advance(1) // hit the capture-relative deadline
    expect(derived.signal.aborted).toBe(true) // force-delivered — NEVER swallowed
    router.dispose()
  })

  test("watchdog bounds delivery from CAPTURE time, not window-open", () => {
    const { time, source, derived, router } = setup()
    router.seam.begin()
    time.advance(30) // section runs 30ms abort-free
    source.abort(new Error("esc")) // capture at t=30 ⇒ deadline t=30+MAX_MS
    time.advance(MAX_MS - 1)
    expect(derived.signal.aborted).toBe(false)
    time.advance(1)
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("late-capture re-arm: end() before the fresh cap delivers synchronously, no leaked timer / double", () => {
    const { time, source, derived, router } = setup()
    const cs = router.seam.begin()
    time.advance(MAX_MS) // window-open watchdog era passes abort-free
    source.abort(new Error("esc")) // fresh watchdog armed
    cs.end() // synchronous honor cancels the fresh watchdog
    expect(derived.signal.aborted).toBe(true)
    expect(() => time.advance(MAX_MS * 4)).not.toThrow()
    expect(time.pending()).toBe(0) // no leaked / double-firing timer
    router.dispose()
  })

  test("non-finite / negative maxMs collapses to 0 (deliver on next tick) — never a permanent hold", () => {
    const time = makeFakeTime()
    const source = new AbortController()
    const derived = new AbortController()
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: time.now,
      maxMs: Number.POSITIVE_INFINITY,
      scheduler: time.scheduler,
    })
    router.seam.begin()
    source.abort(new Error("esc"))
    expect(derived.signal.aborted).toBe(false)
    time.advance(0) // deadline collapsed to now()
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })
})

describe("interrupt-router: end() idempotence + abort never lost", () => {
  test("end() called twice is a no-op", () => {
    const { source, derived, router } = setup()
    const cs = router.seam.begin()
    source.abort(new Error("esc"))
    cs.end()
    expect(derived.signal.aborted).toBe(true)
    expect(() => cs.end()).not.toThrow()
    router.dispose()
  })

  test("nested begin()/end() share ONE window; abort delivered only when the outer closes", () => {
    const { source, derived, router } = setup()
    const outer = router.seam.begin()
    const inner = router.seam.begin()
    source.abort(new Error("esc"))
    inner.end()
    expect(derived.signal.aborted).toBe(false) // outer still open
    outer.end()
    expect(derived.signal.aborted).toBe(true)
    router.dispose()
  })

  test("dispose() after a clean run releases the upstream listener (no late delivery)", () => {
    const { source, derived, router } = setup()
    router.dispose()
    source.abort(new Error("late esc"))
    // dispose detached the listener: derived must NOT abort (the tool already
    // settled; the loop sees config.signal directly at the phase boundary).
    expect(derived.signal.aborted).toBe(false)
  })
})

describe("interrupt-router: StatusBar events (§6.6)", () => {
  test("block mid-section abort emits exactly one deferred then one honored(end)", () => {
    const events: string[] = []
    const observer: InterruptRouterObserver = {
      onDeferred: () => events.push("deferred"),
      onHonored: (r) => events.push(`honored:${r}`),
    }
    const { source, router } = setup({ observer })
    const cs = router.seam.begin()
    source.abort(new Error("esc"))
    cs.end()
    expect(events).toEqual(["deferred", "honored:end"])
    router.dispose()
  })

  test("watchdog force-delivery emits honored(watchdog)", () => {
    const events: string[] = []
    const observer: InterruptRouterObserver = {
      onDeferred: () => events.push("deferred"),
      onHonored: (r) => events.push(`honored:${r}`),
    }
    const { time, source, router } = setup({ observer })
    router.seam.begin()
    source.abort(new Error("esc"))
    time.advance(MAX_MS)
    expect(events).toEqual(["deferred", "honored:watchdog"])
    router.dispose()
  })

  test("late-capture (post window-open watchdog) still emits exactly one deferred + honored(watchdog)", () => {
    const events: string[] = []
    const observer: InterruptRouterObserver = {
      onDeferred: () => events.push("deferred"),
      onHonored: (r) => events.push(`honored:${r}`),
    }
    const { time, source, router } = setup({ observer })
    router.seam.begin()
    time.advance(MAX_MS * 4) // abort-free, well past the window-open era
    source.abort(new Error("esc")) // captured ⇒ fresh watchdog
    time.advance(MAX_MS)
    expect(events).toEqual(["deferred", "honored:watchdog"])
    router.dispose()
  })

  test("a cancel-path abort (no section) emits NEITHER event", () => {
    const events: string[] = []
    const observer: InterruptRouterObserver = {
      onDeferred: () => events.push("deferred"),
      onHonored: (r) => events.push(`honored:${r}`),
    }
    const { source, router } = setup({ observer })
    source.abort(new Error("esc"))
    expect(events).toEqual([])
    router.dispose()
  })

  test("repeated upstream aborts surface deferred ONCE (idempotent capture)", () => {
    const events: string[] = []
    const observer: InterruptRouterObserver = {
      onDeferred: () => events.push("deferred"),
    }
    const { source, router } = setup({ observer })
    router.seam.begin()
    source.abort(new Error("esc"))
    // a second abort() on an already-aborted controller is a no-op in the DOM
    // contract; assert our deferred line is not double-emitted regardless.
    source.signal.dispatchEvent?.(new Event("abort"))
    expect(events).toEqual(["deferred"])
    router.dispose()
  })

  test("absent observer ⇒ no throw on the whole defer/honor path", () => {
    const { time, source, router } = setup()
    router.seam.begin()
    expect(() => {
      source.abort(new Error("esc"))
      time.advance(MAX_MS)
    }).not.toThrow()
    router.dispose()
  })
})

describe("interrupt-router: phase-boundary independence (§6.7)", () => {
  test("the SOURCE signal is never mutated by section state (loop reads it directly)", () => {
    const { source, router } = setup()
    const cs = router.seam.begin()
    expect(source.signal.aborted).toBe(false)
    // The loop's between-phase check reads config.signal (= source), which is
    // untouched by begin(); only the DERIVED (ctx.signal) is gated.
    cs.end()
    expect(source.signal.aborted).toBe(false)
    router.dispose()
  })
})

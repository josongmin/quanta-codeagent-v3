/**
 * Proactive token-refresh scheduler HELLGATE (ADR-0460).
 *
 * Adversarial proof of every invariant in `../token-refresh-scheduler.ts`:
 *
 *   H1  schedules at expiry - LEAD_MS (exact fire delay)
 *   H2  fake-clock fire triggers rotate exactly once
 *   H3  re-schedules from the NEW token's expiry after a successful refresh
 *   H4  token WITHOUT expiry ⇒ never scheduled (no-op, pendingCount 0)
 *   H5  refresh failure ⇒ bounded exponential backoff retry, NO tight loop
 *   H6  refresh failure ⇒ onError called with id + error
 *   H7  onError that THROWS does not poison the scheduler / leak a rejection
 *   H8  stop() clears ALL pending timers (no leak)
 *   H9  re-schedule of same id clears the prior timer (exactly one per id)
 *   H10 overlap with a manual rotate() coalesces (single-flight, one refresh)
 *   H11 the timer callback NEVER rejects out of the timer (unhandled-rejection
 *       guard) even when refresh rejects synchronously-ish
 *   H12 default-OFF: a rotator never wrapped by a scheduler is byte-identical
 *       (rotation stays caller-driven; no timer ever armed)
 *   H13 deadline already in the past ⇒ delay clamped to 0 (fires next tick, not
 *       scheduled in the past / not dropped)
 *   H14 fresh token with NO expiry ⇒ no re-schedule after a successful refresh
 *   H15 cancel() removes one id's timer without touching others
 *   H16 backoff is monotonic non-decreasing and capped at BACKOFF_MAX_MS
 */

import { describe, expect, test } from "bun:test"
import type { ClockPort, TokenRecord, TokenStorePort } from "@/connectors"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  createTokenRefreshScheduler,
  createTokenRotator,
  LEAD_MS,
  type TimerHandle,
  type TimerPort,
} from "@/connectors"

// ── Fakes ────────────────────────────────────────────────────────────────────

const newStore = (): TokenStorePort & { map: Map<string, TokenRecord> } => {
  const map = new Map<string, TokenRecord>()
  return {
    map,
    read: async (id) => map.get(id),
    write: async (id, r) => {
      map.set(id, r)
    },
    delete: async (id) => {
      map.delete(id)
    },
  }
}

const clockOf = (start = 0): ClockPort & { set(v: number): void; advance(d: number): void } => {
  let now = start
  return {
    now: () => now,
    set: (v) => {
      now = v
    },
    advance: (d) => {
      now += d
    },
  }
}

interface FakeTimer extends TimerPort {
  /** Fire the timer scheduled with the smallest delay, return its delay. */
  fireNext(): Promise<number | undefined>
  /** Fire every armed timer once (in insertion order snapshot). */
  fireAll(): Promise<void>
  /** Delays of all currently-armed timers. */
  delays(): number[]
  /** Number of currently-armed timers. */
  size(): number
  /** Total number of timers EVER armed (leak/loop detector). */
  totalArmed(): number
}

const fakeTimer = (): FakeTimer => {
  interface Entry {
    handle: symbol
    cb: () => void
    delay: number
  }
  let armed: Entry[] = []
  let total = 0
  const set = (cb: () => void, delay: number): TimerHandle => {
    const handle = Symbol("t")
    armed.push({ handle, cb, delay })
    total += 1
    return handle
  }
  const clear = (handle: TimerHandle): void => {
    armed = armed.filter((e) => e.handle !== handle)
  }
  // Firing must let the async refresh body settle before assertions, so the
  // helpers await a microtask drain.
  const drain = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const fireNext = async (): Promise<number | undefined> => {
    if (armed.length === 0) return undefined
    let idx = 0
    for (let i = 1; i < armed.length; i += 1) {
      const cur = armed[i]
      const best = armed[idx]
      if (cur !== undefined && best !== undefined && cur.delay < best.delay) idx = i
    }
    const [entry] = armed.splice(idx, 1)
    entry?.cb()
    await drain()
    return entry?.delay
  }
  const fireAll = async (): Promise<void> => {
    const snapshot = armed
    armed = []
    for (const e of snapshot) e.cb()
    await drain()
  }
  return {
    set,
    clear,
    fireNext,
    fireAll,
    delays: () => armed.map((e) => e.delay),
    size: () => armed.length,
    totalArmed: () => total,
  }
}

const rec = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  accessToken: "a",
  tokenType: "Bearer",
  ...over,
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("connectors / token-refresh-scheduler hellgate", () => {
  test("H1: schedules at expiry - LEAD_MS", () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    expect(timer.delays()).toEqual([100_000 - LEAD_MS])
    expect(sched.pendingCount()).toBe(1)
  })

  test("H2: fake-clock fire triggers rotate exactly once", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const store = newStore()
    const rotator = createTokenRotator({ tokenStore: store, clockPort: clock })
    let refreshCalls = 0
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => {
        refreshCalls += 1
        return rec({ accessToken: "fresh" })
      },
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    await timer.fireNext()
    expect(refreshCalls).toBe(1)
    expect(store.map.get("c1")?.accessToken).toBe("fresh")
  })

  test("H3: re-schedules from the NEW token's expiry after success", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec({ accessToken: "fresh", expiresAt: 500_000 }),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    await timer.fireNext()
    // New timer armed from the fresh token's expiry (clock still 0).
    expect(timer.delays()).toEqual([500_000 - LEAD_MS])
    expect(sched.pendingCount()).toBe(1)
  })

  test("H4: token WITHOUT expiry ⇒ never scheduled", () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec()) // no expiresAt
    expect(timer.size()).toBe(0)
    expect(timer.totalArmed()).toBe(0)
    expect(sched.pendingCount()).toBe(0)
  })

  test("H5+H6: refresh failure ⇒ bounded backoff retry + onError, NO tight loop", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const errors: Array<{ id: string; e: unknown }> = []
    let calls = 0
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => {
        calls += 1
        throw new Error(`boom-${calls}`)
      },
      onError: (id, e) => errors.push({ id, e }),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    // Fire the proactive timer → refresh throws → onError + backoff re-arm.
    await timer.fireNext()
    expect(calls).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0]?.id).toBe("c1")
    // EXACTLY one retry timer armed (no tight loop firing synchronously).
    expect(timer.size()).toBe(1)
    expect(timer.delays()).toEqual([BACKOFF_BASE_MS]) // attempt 0 → base

    // Fire the first backoff retry → still fails → next backoff doubles.
    await timer.fireNext()
    expect(calls).toBe(2)
    expect(errors.length).toBe(2)
    expect(timer.size()).toBe(1)
    expect(timer.delays()).toEqual([BACKOFF_BASE_MS * 2])
  })

  test("H7: onError that throws does not poison the scheduler", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => {
        throw new Error("boom")
      },
      onError: () => {
        throw new Error("observer-explodes")
      },
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    // Must not throw out of fireNext; backoff retry must still be armed.
    await timer.fireNext()
    expect(timer.size()).toBe(1)
    expect(timer.delays()).toEqual([BACKOFF_BASE_MS])
  })

  test("H8: stop() clears ALL pending timers (no leak)", () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    sched.schedule("c2", rec({ expiresAt: 200_000 }))
    sched.schedule("c3", rec({ expiresAt: 300_000 }))
    expect(sched.pendingCount()).toBe(3)
    sched.stop()
    expect(sched.pendingCount()).toBe(0)
    expect(timer.size()).toBe(0)
  })

  test("H9: re-schedule of same id clears the prior timer", () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    sched.schedule("c1", rec({ expiresAt: 200_000 }))
    // Exactly one timer for c1, armed from the NEW expiry.
    expect(timer.size()).toBe(1)
    expect(timer.delays()).toEqual([200_000 - LEAD_MS])
    expect(sched.pendingCount()).toBe(1)
  })

  test("H10: overlap with a manual rotate() coalesces (single-flight)", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    let refreshCalls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const refresh = async (): Promise<TokenRecord> => {
      refreshCalls += 1
      await gate
      return rec({ accessToken: "fresh" })
    }
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh,
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    // Start a MANUAL rotate (in-flight, blocked on gate)…
    const manual = rotator.rotate("c1", refresh)
    // …then fire the scheduled timer for the SAME id while manual is in flight.
    const fire = timer.fireNext()
    // Release the single in-flight refresh.
    release()
    await Promise.all([manual, fire])
    // Single-flight: the rotator's mutex coalesced both → exactly one refresh.
    expect(refreshCalls).toBe(1)
  })

  test("H11: timer callback never rejects out of the timer", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    let unhandled = false
    const onUnhandled = (): void => {
      unhandled = true
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const sched = createTokenRefreshScheduler({
        rotator,
        clockPort: clock,
        timerPort: timer,
        refresh: async () => {
          throw new Error("reject")
        },
        // no onError on purpose — error must still be swallowed
      })
      sched.schedule("c1", rec({ expiresAt: 100_000 }))
      await timer.fireNext()
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toBe(false)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("H12: default-OFF — rotator without a scheduler is byte-identical", async () => {
    // No scheduler constructed. Rotation stays purely caller-driven.
    const timer = fakeTimer()
    const clock = clockOf(0)
    const store = newStore()
    const rotator = createTokenRotator({ tokenStore: store, clockPort: clock })
    const got = await rotator.rotate("c1", async () => rec({ accessToken: "n", expiresAt: 9 }))
    expect(got.accessToken).toBe("n")
    expect(store.map.get("c1")?.accessToken).toBe("n")
    // No scheduler ⇒ no timer ever armed.
    expect(timer.totalArmed()).toBe(0)
  })

  test("H13: deadline already in the past ⇒ delay clamped to 0", () => {
    const timer = fakeTimer()
    const clock = clockOf(1_000_000) // far past the deadline
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec({ expiresAt: 10_000 })) // expiry < now
    expect(timer.delays()).toEqual([0])
  })

  test("H14: fresh token with no expiry ⇒ no re-schedule after success", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec({ accessToken: "fresh" }), // no expiresAt
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    await timer.fireNext()
    // Fresh token had no expiry ⇒ nothing re-armed.
    expect(timer.size()).toBe(0)
    expect(sched.pendingCount()).toBe(0)
  })

  test("H15: cancel() removes one id's timer without touching others", () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => rec(),
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    sched.schedule("c2", rec({ expiresAt: 200_000 }))
    sched.cancel("c1")
    expect(sched.pendingCount()).toBe(1)
    expect(timer.size()).toBe(1)
    expect(timer.delays()).toEqual([200_000 - LEAD_MS]) // c2 survives
  })

  test("H16: backoff is monotonic non-decreasing and capped", async () => {
    const timer = fakeTimer()
    const clock = clockOf(0)
    const rotator = createTokenRotator({ tokenStore: newStore(), clockPort: clock })
    const sched = createTokenRefreshScheduler({
      rotator,
      clockPort: clock,
      timerPort: timer,
      refresh: async () => {
        throw new Error("always-fails")
      },
    })
    sched.schedule("c1", rec({ expiresAt: 100_000 }))
    await timer.fireNext() // proactive fire → attempt 0 retry armed
    const seen: number[] = []
    // Drive many failing retries; each fire arms exactly one next timer.
    for (let i = 0; i < 15; i += 1) {
      const [d] = timer.delays()
      if (d !== undefined) seen.push(d)
      expect(timer.size()).toBe(1) // never a tight loop / never multiple
      await timer.fireNext()
    }
    // Monotonic non-decreasing.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number)
    }
    // Capped.
    for (const d of seen) expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS)
    expect(seen[seen.length - 1]).toBe(BACKOFF_MAX_MS)
  })
})

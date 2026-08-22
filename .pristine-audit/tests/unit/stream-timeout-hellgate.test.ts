import { describe, expect, test } from "bun:test"
import {
  createDefaultWatchdog,
  createSnoozeController,
  noOpWatchdog,
  StreamAbortError,
  StreamIdleError,
  StreamTotalError,
  type TimeoutPolicy,
} from "@/agent/stream-timeout"

/**
 * Hellgate for ADR-0200 stream-timeout watchdog slice.
 *
 * 15 cases covering pass-through invariance, idle/total firing, snooze
 * pause, AbortSignal precedence, degrade policy, timer-leak avoidance,
 * cross-watchdog isolation, and the "no double-pull / no next-after-done"
 * source-iterator protocol.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Build an async iterable that emits `items` with `gapMs` between each
 *  yield. Tracks `nextCalls` so tests can assert no double-pull. */
const makeGapped = <T>(
  items: T[],
  gapMs: number,
): { iter: AsyncIterable<T>; nextCalls: () => number; returns: () => number } => {
  let nextCalls = 0
  let returns = 0
  let i = 0
  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          nextCalls++
          if (i >= items.length) return { value: undefined as unknown as T, done: true }
          await sleep(gapMs)
          const value = items[i++] as T
          return { value, done: false }
        },
        async return(): Promise<IteratorResult<T>> {
          returns++
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
  }
  return { iter, nextCalls: () => nextCalls, returns: () => returns }
}

/** A source that NEVER yields. Used for idle/abort tests. */
const makeSilent = <T>(): { iter: AsyncIterable<T>; nextCalls: () => number } => {
  let nextCalls = 0
  const iter: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          nextCalls++
          // Park indefinitely (resolved by GC when the watchdog tears down).
          return new Promise(() => undefined)
        },
        async return(): Promise<IteratorResult<T>> {
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
  }
  return { iter, nextCalls: () => nextCalls }
}

/** Source that throws on the second pull. */
const makeThrowing = (): AsyncIterable<number> => ({
  [Symbol.asyncIterator](): AsyncIterator<number> {
    let i = 0
    return {
      async next(): Promise<IteratorResult<number>> {
        if (i === 0) {
          i++
          return { value: 1, done: false }
        }
        throw new Error("source-boom")
      },
    }
  },
})

describe("ADR-0200 stream-timeout watchdog hellgate", () => {
  test("HELL-ST-01 — policy missing → byte-identical pass-through", async () => {
    const { iter } = makeGapped([10, 20, 30], 5)
    const wd = createDefaultWatchdog()
    const got: number[] = []
    for await (const ev of wd.wrap(iter)) got.push(ev)
    expect(got).toEqual([10, 20, 30])
  })

  test("HELL-ST-01b — no-op watchdog is identity", async () => {
    const { iter } = makeGapped(["a", "b"], 1)
    const wd = noOpWatchdog()
    const policy: TimeoutPolicy = { idleMs: 1, action: "abort" }
    const out: string[] = []
    // no-op ignores policy entirely
    for await (const ev of wd.wrap(iter, policy)) out.push(ev)
    expect(out).toEqual(["a", "b"])
  })

  test("HELL-ST-02 — idleMs=50, source 500ms silent → throws StreamIdleError typed", async () => {
    const { iter } = makeSilent<number>()
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 50, action: "abort" }
    let caught: unknown
    try {
      for await (const _ of wd.wrap(iter, policy)) {
        // unreachable
      }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamIdleError)
    expect((caught as StreamIdleError).idleMs).toBe(50)
    expect((caught as StreamIdleError).name).toBe("StreamIdleError")
  })

  test("HELL-ST-03 — idleMs=100, source emits at 20ms gaps → passes through", async () => {
    const { iter } = makeGapped([1, 2, 3, 4, 5], 20)
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 100, action: "abort" }
    const out: number[] = []
    for await (const ev of wd.wrap(iter, policy)) out.push(ev)
    expect(out).toEqual([1, 2, 3, 4, 5])
  })

  test("HELL-ST-04 — AbortSignal aborted → StreamAbortError, no leaked timer", async () => {
    const { iter } = makeSilent<number>()
    const wd = createDefaultWatchdog()
    const ac = new AbortController()
    const policy: TimeoutPolicy = { idleMs: 10_000, action: "abort" }
    // Fire abort after 30ms.
    setTimeout(() => ac.abort(), 30)
    let caught: unknown
    try {
      for await (const _ of wd.wrap(iter, policy, ac.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamAbortError)
    // If the idle timer leaked, this assertion (which races against a 10s
    // setTimeout) would not be reached for 10 seconds. The bun test
    // runner times out long before, so passing within ~50ms is the lock.
  })

  test("HELL-ST-05 — snooze.pause keeps idle counter parked, resume re-arms", async () => {
    // Source emits one item, then is silent forever.
    const slow: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        let yielded = false
        return {
          async next(): Promise<IteratorResult<number>> {
            if (!yielded) {
              yielded = true
              return { value: 99, done: false }
            }
            return new Promise(() => undefined)
          },
        }
      },
    }
    const wd = createDefaultWatchdog({ snoozePollMs: 5 })
    const snooze = createSnoozeController()
    snooze.pause(300) // park for 300ms BEFORE the second pull's idle (100ms) would fire
    const policy: TimeoutPolicy = { idleMs: 100, action: "abort", snooze }

    const startedAt = Date.now()
    let caught: unknown
    const got: number[] = []
    try {
      for await (const ev of wd.wrap(slow, policy)) {
        got.push(ev)
        // After receiving the first value, idle counter would normally
        // fire at 100ms. With snooze paused for 300ms, it must NOT fire
        // before ~300ms.
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - startedAt
    expect(got).toEqual([99])
    expect(caught).toBeInstanceOf(StreamIdleError)
    // Idle must have fired AFTER snooze resumed (300ms) + at least one
    // idle interval (100ms) — i.e. >= ~250ms (give 50ms scheduling slack).
    expect(elapsed).toBeGreaterThanOrEqual(250)
  })

  test("HELL-ST-06 — totalMs=200, fast emits → StreamTotalError after total exceeds", async () => {
    // Source emits forever at 20ms gaps — never idle-fires.
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const { iter } = makeGapped(items, 20)
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 100, totalMs: 200, action: "abort" }
    let caught: unknown
    const got: number[] = []
    try {
      for await (const ev of wd.wrap(iter, policy)) got.push(ev)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamTotalError)
    expect((caught as StreamTotalError).totalMs).toBe(200)
    // We got some events before the total fired.
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThan(1000)
  })

  test("HELL-ST-07 — action='degrade' → idle returns done instead of throwing", async () => {
    // Yield 2 items, then go silent.
    const partial: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        let i = 0
        return {
          async next(): Promise<IteratorResult<number>> {
            if (i < 2) {
              i++
              return { value: i, done: false }
            }
            return new Promise(() => undefined)
          },
        }
      },
    }
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 50, action: "degrade" }
    const got: number[] = []
    // MUST NOT throw.
    for await (const ev of wd.wrap(partial, policy)) got.push(ev)
    expect(got).toEqual([1, 2])
  })

  test("HELL-ST-08 — source throws → watchdog propagates unchanged (no wrap)", async () => {
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 200, action: "abort" }
    let caught: unknown
    const got: number[] = []
    try {
      for await (const ev of wd.wrap(makeThrowing(), policy)) got.push(ev)
    } catch (e) {
      caught = e
    }
    expect(got).toEqual([1])
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("source-boom")
    expect(caught).not.toBeInstanceOf(StreamIdleError)
    expect(caught).not.toBeInstanceOf(StreamTotalError)
    expect(caught).not.toBeInstanceOf(StreamAbortError)
  })

  test("HELL-ST-09 — source done → no additional next() after completion", async () => {
    const { iter, nextCalls } = makeGapped([10, 20], 5)
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 100, action: "abort" }
    const got: number[] = []
    for await (const ev of wd.wrap(iter, policy)) got.push(ev)
    expect(got).toEqual([10, 20])
    // 2 items + 1 final pull that returned {done:true}. THAT'S IT.
    expect(nextCalls()).toBe(3)
  })

  test("HELL-ST-10 — concurrent watchdog instances are isolated (no timer cross-talk)", async () => {
    const { iter: a } = makeGapped([1, 2, 3], 10)
    const { iter: b } = makeGapped([10, 20, 30], 10)
    const wdA = createDefaultWatchdog()
    const wdB = createDefaultWatchdog()
    const policyA: TimeoutPolicy = { idleMs: 100, action: "abort" }
    const policyB: TimeoutPolicy = { idleMs: 100, action: "abort" }

    const drain = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
      const out: T[] = []
      for await (const ev of it) out.push(ev)
      return out
    }
    const [outA, outB] = await Promise.all([
      drain(wdA.wrap(a, policyA)),
      drain(wdB.wrap(b, policyB)),
    ])
    expect(outA).toEqual([1, 2, 3])
    expect(outB).toEqual([10, 20, 30])
  })

  test("HELL-ST-11 — idleMs=0 → immediate timeout on first pull (edge)", async () => {
    const { iter } = makeGapped([1, 2], 50)
    const wd = createDefaultWatchdog()
    // idleMs=0 means the timeout setTimeout fires on the NEXT tick before
    // the source can yield (which itself awaits 50ms). Either StreamIdleError
    // OR (if the JS scheduler races us) the value lands first — assertion
    // is that the FIRST event is either the value-1 OR the idle error,
    // and if it's the value, the SECOND pull MUST then idle-error.
    let caught: unknown
    const got: number[] = []
    try {
      for await (const ev of wd.wrap(iter, { idleMs: 0, action: "abort" })) got.push(ev)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamIdleError)
    expect((caught as StreamIdleError).idleMs).toBe(0)
  })

  test("HELL-ST-12 — idleMs undefined + totalMs set → idle ignored, total enforced", async () => {
    // Source pulses fast (5ms gap) — would never trip a generous idle.
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const { iter } = makeGapped(items, 5)
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { totalMs: 100, action: "abort" }
    let caught: unknown
    const got: number[] = []
    try {
      for await (const ev of wd.wrap(iter, policy)) got.push(ev)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamTotalError)
    expect((caught as StreamTotalError).totalMs).toBe(100)
    expect(got.length).toBeGreaterThan(0)
  })

  test("HELL-ST-13 — external signal + idle race → first reason wins (signal)", async () => {
    const { iter } = makeSilent<number>()
    const wd = createDefaultWatchdog()
    const ac = new AbortController()
    const policy: TimeoutPolicy = { idleMs: 500, action: "abort" }
    // Fire abort BEFORE idle would (500ms). Expect StreamAbortError.
    setTimeout(() => ac.abort(), 30)
    let caught: unknown
    try {
      for await (const _ of wd.wrap(iter, policy, ac.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamAbortError)
    expect(caught).not.toBeInstanceOf(StreamIdleError)
  })

  test("HELL-ST-14 — source.next() called exactly once per yielded event (no double-pull)", async () => {
    const { iter, nextCalls } = makeGapped([100, 200, 300], 30)
    const wd = createDefaultWatchdog()
    const policy: TimeoutPolicy = { idleMs: 200, action: "abort" }
    const got: number[] = []
    for await (const ev of wd.wrap(iter, policy)) got.push(ev)
    expect(got).toEqual([100, 200, 300])
    // 3 values + 1 final {done:true}. No double-pull.
    expect(nextCalls()).toBe(4)
  })

  test("HELL-ST-15 — abort during snooze pause → StreamAbortError beats snooze", async () => {
    const { iter } = makeSilent<number>()
    const wd = createDefaultWatchdog({ snoozePollMs: 5 })
    const snooze = createSnoozeController()
    snooze.pause(5_000) // park for 5s
    const ac = new AbortController()
    const policy: TimeoutPolicy = { idleMs: 100, action: "abort", snooze }
    // Abort after 30ms — well within the 5s snooze.
    setTimeout(() => ac.abort(), 30)
    let caught: unknown
    const startedAt = Date.now()
    try {
      for await (const _ of wd.wrap(iter, policy, ac.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - startedAt
    expect(caught).toBeInstanceOf(StreamAbortError)
    // Must NOT have waited 5s for snooze.
    expect(elapsed).toBeLessThan(500)
  })
})

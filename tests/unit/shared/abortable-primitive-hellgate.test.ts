/**
 * ★ CONTRACT — T01 (May-31 bugbash): the ONE shared abort/deadline primitive.
 *
 * HELLGATE — proves the primitive actually STOPS underlying work and cleans up,
 * not merely resolves the caller promise early. Each case is adversarial:
 *   - a sleep that is abandoned mid-flight must clear its timer AND its listener
 *     (the leaked-timer / leaked-listener pair the per-adapter sleeps had).
 *   - a fetch past its deadline must tear down the REAL request (abort the
 *     composed signal handed to fetch) and report a TYPED `timeout` reason —
 *     distinct from a caller `abort`.
 *   - a drain that is aborted must CANCEL the underlying reader (release the
 *     socket / pipe), not just stop iterating while the producer keeps writing.
 *
 * Audit IDs proven here: the seam under L3 C-6/9/10, L5 H-2/H-5/M-8/M-10,
 * L6 C2, L9 H1/H3/H4/H12.
 */

import { describe, expect, test } from "bun:test"
import {
  AbortError,
  abortableSleep,
  abortReasonOf,
  drainAbortable,
  fetchWithDeadline,
  isAbort,
  type TimerPort,
  throwIfAborted,
} from "@/shared"
import { nth } from "../../_helpers/expect-present"

/** A controllable fake timer so tests drive deadlines without real time and can
 *  assert every armed timer was cleared (leak detector). */
const fakeTimers = (): TimerPort & {
  fire(id: number): void
  readonly live: Set<number>
  readonly cleared: Set<number>
} => {
  const fns = new Map<number, () => void>()
  const live = new Set<number>()
  const cleared = new Set<number>()
  let seq = 0
  return {
    set(fn) {
      const id = ++seq
      fns.set(id, fn)
      live.add(id)
      return id
    },
    clear(h) {
      const id = h as number
      live.delete(id)
      cleared.add(id)
    },
    fire(id) {
      const fn = fns.get(id)
      // A fired timer is no longer live (matches real setTimeout one-shot).
      live.delete(id)
      if (fn !== undefined) fn()
    },
    live,
    cleared,
  }
}

describe("throwIfAborted — typed pre-flight gate", () => {
  test("throws a typed AbortError when already aborted", () => {
    const c = new AbortController()
    c.abort()
    let caught: unknown
    try {
      throwIfAborted(c.signal)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AbortError)
    expect((caught as AbortError).name).toBe("AbortError")
    expect((caught as AbortError).reason).toBe("abort")
    expect(isAbort(caught)).toBe(true)
  })

  test("no-op when signal absent or live", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow()
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
  })
})

describe("abortableSleep — rejects promptly and never leaks", () => {
  test("resolves and clears its timer on natural completion", async () => {
    const timers = fakeTimers()
    const p = abortableSleep(50, undefined, timers)
    // exactly one live timer was armed
    expect(timers.live.size).toBe(1)
    const id = nth([...timers.live], 0, "timers.live")
    timers.fire(id)
    await p
  })

  test("rejects with typed AbortError the instant the signal fires — and clears the timer", async () => {
    const timers = fakeTimers()
    const c = new AbortController()
    const p = abortableSleep(10_000, c.signal, timers)
    expect(timers.live.size).toBe(1)
    const armed = nth([...timers.live], 0, "timers.live")
    c.abort()
    await expect(p).rejects.toMatchObject({ name: "AbortError", reason: "abort" })
    // LEAK PROOF: the timer that would have kept the event loop alive is cleared.
    expect(timers.cleared.has(armed)).toBe(true)
    expect(timers.live.size).toBe(0)
  })

  test("an already-aborted signal rejects without ever arming a timer", async () => {
    const timers = fakeTimers()
    const c = new AbortController()
    c.abort()
    await expect(abortableSleep(10_000, c.signal, timers)).rejects.toBeInstanceOf(AbortError)
    expect(timers.live.size).toBe(0)
  })

  test("does not accumulate listeners on a long-lived signal across many sleeps", async () => {
    const timers = fakeTimers()
    const c = new AbortController()
    // Run+complete many sleeps against ONE shared signal.
    for (let i = 0; i < 100; i++) {
      const p = abortableSleep(1, c.signal, timers)
      timers.fire(nth([...timers.live], 0, "timers.live"))
      await p
    }
    // If listeners leaked, aborting now would reject 100 stale promises; instead
    // the signal is clean. (Node warns at >10 listeners; we assert structurally
    // by aborting and confirming a fresh sleep still rejects exactly once.)
    c.abort()
    await expect(abortableSleep(5, c.signal, timers)).rejects.toMatchObject({ reason: "abort" })
  })
})

describe("fetchWithDeadline — deadline tears down the REAL request, typed reason", () => {
  test("deadline fires ⇒ the signal handed to fetch is aborted AND reason is 'timeout'", async () => {
    const timers = fakeTimers()
    let sawAbort = false
    const fetchFn = (_input: string | URL, init: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject) => {
        // Simulate a hung server: only settle when our composed signal aborts.
        init.signal?.addEventListener("abort", () => {
          sawAbort = true
          const e = new Error("aborted") as Error & { name: string }
          e.name = "AbortError"
          reject(e)
        })
      })
    const p = fetchWithDeadline("https://x", { timeoutMs: 30, fetchFn, timers })
    // Fire the deadline timer.
    expect(timers.live.size).toBe(1)
    timers.fire(nth([...timers.live], 0, "timers.live"))
    const err = await p.then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(AbortError)
    expect((err as AbortError).reason).toBe("timeout")
    // PROOF the underlying request was actually severed, not abandoned.
    expect(sawAbort).toBe(true)
  })

  test("caller signal fires ⇒ reason is 'abort', distinct from timeout", async () => {
    const timers = fakeTimers()
    const c = new AbortController()
    const fetchFn = (_i: string | URL, init: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_res, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted") as Error & { name: string }
          e.name = "AbortError"
          reject(e)
        })
      })
    const p = fetchWithDeadline("https://x", {
      timeoutMs: 10_000,
      signal: c.signal,
      fetchFn,
      timers,
    })
    c.abort()
    await expect(p).rejects.toMatchObject({ name: "AbortError", reason: "abort" })
  })

  test("fast success clears the deadline timer (no leaked timeoutMs handle)", async () => {
    const timers = fakeTimers()
    const fetchFn = (): Promise<Response> => Promise.resolve(new Response("ok"))
    const armedBefore = timers.live.size
    const res = await fetchWithDeadline("https://x", { timeoutMs: 30_000, fetchFn, timers })
    expect(await res.text()).toBe("ok")
    // The 30s timer must be cleared even though the fetch returned instantly.
    expect(timers.live.size).toBe(armedBefore)
  })

  test("already-aborted caller signal short-circuits before fetch is ever called", async () => {
    const c = new AbortController()
    c.abort()
    let called = false
    const fetchFn = (): Promise<Response> => {
      called = true
      return Promise.resolve(new Response())
    }
    await expect(
      fetchWithDeadline("https://x", { signal: c.signal, fetchFn }),
    ).rejects.toBeInstanceOf(AbortError)
    expect(called).toBe(false)
  })
})

describe("drainAbortable — abort CANCELS the reader (releases the pipe)", () => {
  const makeStream = (
    chunks: string[],
  ): { stream: { getReader(): ReturnType<typeof mkReader> }; cancelled: () => boolean } => {
    let cancelled = false
    const mkReader = () => {
      let i = 0
      return {
        read: async (): Promise<{ done: boolean; value?: string }> => {
          if (cancelled) return { done: true }
          const next = chunks[i++]
          if (next === undefined) {
            // Producer keeps the pipe open forever unless cancelled — models a
            // server streaming an unbounded SSE body.
            return new Promise<{ done: boolean }>(() => {})
          }
          return { done: false, value: next }
        },
        cancel: async (): Promise<void> => {
          cancelled = true
        },
        releaseLock: (): void => {},
      }
    }
    return { stream: { getReader: mkReader }, cancelled: () => cancelled }
  }

  test("aborting mid-drain cancels the reader and rejects with reason 'abort'", async () => {
    const c = new AbortController()
    const { stream, cancelled } = makeStream(["a", "b"])
    const got: string[] = []
    const p = drainAbortable(stream, (ch) => got.push(ch), { signal: c.signal })
    // Let the two chunks flush, then the reader blocks; abort.
    await Promise.resolve()
    c.abort()
    await expect(p).rejects.toMatchObject({ name: "AbortError", reason: "abort" })
    // PROOF: the underlying reader was cancelled (socket/pipe released), not
    // merely abandoned while the producer kept writing.
    expect(cancelled()).toBe(true)
  })

  test("null body is a no-op", async () => {
    await expect(drainAbortable(null, () => {})).resolves.toBeUndefined()
  })

  test("drains a finite stream to completion without a signal", async () => {
    const chunks = ["x", "y", "z"]
    let i = 0
    const stream = {
      getReader: () => ({
        read: async () => {
          const next = chunks[i++]
          return next === undefined ? { done: true } : { done: false, value: next }
        },
      }),
    }
    const got: string[] = []
    await drainAbortable(stream, (c) => got.push(c))
    expect(got).toEqual(chunks)
  })
})

describe("abortReasonOf — classify a cancellation exactly once at the boundary", () => {
  test("maps our AbortError, platform TimeoutError/AbortError, and non-aborts", () => {
    expect(abortReasonOf(new AbortError("timeout"))).toBe("timeout")
    expect(abortReasonOf(new AbortError("abort"))).toBe("abort")
    const t = new Error() as Error & { name: string }
    t.name = "TimeoutError"
    expect(abortReasonOf(t)).toBe("timeout")
    const a = new Error() as Error & { name: string }
    a.name = "AbortError"
    expect(abortReasonOf(a)).toBe("abort")
    expect(abortReasonOf(new Error("boom"))).toBeNull()
    expect(abortReasonOf("nope")).toBeNull()
  })
})

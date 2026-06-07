/**
 * ★ HELLGATE — node-repl readUntil timer-leak on reader.read() REJECTION (H14).
 *
 * The timeout-race in `readUntil` clears its bounded self-expiring timer on the
 * RESOLVE path (TIMED_OUT or a real chunk). The original fix SKIPPED the cleanup
 * when `reader.read()` REJECTS mid-wait: the `catch` returned before the lone
 * `clearTimeout(timer)` ran, leaking a setTimeout handle on every rejecting read.
 * FIX: the timer is captured outside the inner try and cancelled in a `finally`,
 * so EVERY exit (resolve, timeout, reject) clears it.
 *
 * This injects a `ChunkReader` whose `read()` rejects, spies on clearTimeout, and
 * asserts the race timer was cancelled. Against the still-holed code (clearTimeout
 * only on the resolve branch) the reject path skips it and this assertion fails.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { type ReadUntilTimers, readUntil } from "@/runtime/node-repl/default-kernel"

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

describe("node-repl readUntil clears the race timer even when read() rejects (H14)", () => {
  let cleared: Array<unknown>
  let armed: Array<unknown>
  // LOCAL injected timers — the spy is scoped to THIS readUntil call, never the
  // process-global `setTimeout`. Monkeypatching the global made the assertion
  // flaky: bun runs test files concurrently in one process, so a sibling file's
  // `setTimeout` could land in `armed` and never be cleared by readUntil.
  let timers: ReadUntilTimers

  beforeEach(() => {
    cleared = []
    armed = []
    timers = {
      set: (fn, ms) => {
        const h = setTimeout(fn, ms)
        armed.push(h)
        return h
      },
      clear: (h) => {
        cleared.push(h)
        clearTimeout(h)
      },
    }
  })

  test("a read() that REJECTS mid-wait still clears the bounded race timer (no dangling handle)", async () => {
    // read() rejects after a short delay — long enough that the race timer is
    // armed and pending, short enough that the timeout (large) does NOT win.
    const rejecting: ChunkReader = {
      read: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("stream torn")), 10)
        }),
      releaseLock: () => {},
    }

    // timeoutMs > 0 so the timeout-race branch (the one with the timer) runs.
    const res = await readUntil(rejecting, "__never__", 5_000, timers)

    // The reject surfaces as a failed read (not a timeout).
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).not.toContain("timeout")
      expect(res.error).toContain("stream torn")
    }

    // THE FIX — the race timer that was armed must have been cleared on the
    // reject path. Holed code returns from the catch before clearTimeout, so
    // `armed` has a handle that never appears in `cleared`.
    expect(armed.length).toBeGreaterThan(0)
    for (const h of armed) {
      expect(cleared).toContain(h)
    }
  })

  test("the resolve path still clears its timer (no over-correction / double-clear regression)", async () => {
    const okReader: ChunkReader = {
      read: () =>
        Promise.resolve({ done: false, value: new TextEncoder().encode("X__sentinel__Y") }),
      releaseLock: () => {},
    }
    const res = await readUntil(okReader, "__sentinel__", 5_000, timers)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.body).toBe("X")
    expect(armed.length).toBeGreaterThan(0)
    for (const h of armed) {
      expect(cleared).toContain(h)
    }
  })
})

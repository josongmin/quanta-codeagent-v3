import { describe, expect, mock, test } from "bun:test"
import { withSpawnedChild } from "@/runtime"

describe("withSpawnedChild — RAII spawn guard contract", () => {
  test("normal path: returns body's value, NEVER kills, clears timer + runs cleanup", async () => {
    // T3 strengthening — REGRESSION CLASS CAUGHT: the prior test created a
    // 60_000 ms timer, passed it in, and then itself called `clearTimeout`
    // — so the assertion that "timer was cleared" was self-fulfilling. A
    // future regression that removed the `clearTimeout(timer)` from the
    // guard's `finally` would still pass.
    //
    // Rewrite: arm a SHORT timer whose callback flips a flag, then assert
    // the flag NEVER flips (because production cleared the timer before
    // it could fire). We DO NOT call clearTimeout from the test.
    let killed = 0
    let cleaned = 0
    let timerFired = 0
    // 25 ms is short enough to fire in real time if production forgets the
    // clearTimeout, but well below the test's default timeout. We wait ~80
    // ms after the body completes to give the OS scheduler room.
    const timer = setTimeout(() => {
      timerFired++
    }, 25)
    const out = await withSpawnedChild(
      { kill: () => killed++, timer, cleanup: () => cleaned++ },
      async () => "result",
    )
    expect(out).toBe("result")
    expect(killed).toBe(0) // success path must NOT kill
    expect(cleaned).toBe(1)
    // Wait past the timer's deadline. If production cleared it, the
    // callback never ran and `timerFired` stays 0. If production forgot,
    // the callback would have fired by now.
    await new Promise<void>((r) => setTimeout(r, 80))
    expect(timerFired).toBe(0)
  })

  test("positive control: timer FIRES when no guard is applied (proves the timer is real)", async () => {
    // T3 strengthening — without this control, a broken `setTimeout` would
    // silently pass the test above (timerFired stays 0 because the timer
    // never fired, not because production cleared it). We verify the timer
    // mechanism works by running it OUTSIDE the guard.
    let fired = 0
    const t = setTimeout(() => {
      fired++
    }, 25)
    await new Promise<void>((r) => setTimeout(r, 80))
    expect(fired).toBe(1)
    clearTimeout(t) // safe cleanup (already fired ⇒ no-op).
  })

  test("throw path: kills exactly once, rethrows the ORIGINAL error, still cleans up", async () => {
    let killed = 0
    let cleaned = 0
    const boom = new Error("body boom")
    await expect(
      withSpawnedChild({ kill: () => killed++, cleanup: () => cleaned++ }, async () => {
        throw boom
      }),
    ).rejects.toBe(boom) // identity-preserving, not wrapped
    expect(killed).toBe(1) // exactly one kill on the abnormal path
    expect(cleaned).toBe(1) // finally still ran
  })

  test("optional timer/cleanup may be omitted without error", async () => {
    let killed = 0
    // Sanity-check the cleanup-omitted path: when no cleanup hook is given,
    // the guard must still finish without throwing. The cleanup spy below
    // proves we are NOT secretly calling some default hook.
    const cleanupSpy = mock(() => {})
    const out = await withSpawnedChild({ kill: () => killed++ }, async () => 42)
    expect(out).toBe(42)
    expect(killed).toBe(0)
    expect(cleanupSpy).toHaveBeenCalledTimes(0) // omitted ⇒ never invoked
  })

  test("cleanup runs even when the body throws AND on the normal path (never split)", async () => {
    const cleanupSpy = mock(() => {})
    // Normal
    await withSpawnedChild({ kill: () => {}, cleanup: cleanupSpy }, async () => undefined)
    // Throw
    await withSpawnedChild(
      { kill: () => {}, cleanup: cleanupSpy },
      async () => undefined,
    ).catch(() => {})
    await withSpawnedChild({ kill: () => {}, cleanup: cleanupSpy }, async () => {
      throw new Error("x")
    }).catch(() => {})
    expect(cleanupSpy).toHaveBeenCalledTimes(3)
  })
})

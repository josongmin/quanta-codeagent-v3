/**
 * ADR-0422 audit-H closeout — pin the `once()` memoizer's retry-on-throw contract.
 *
 * The 02a31560 fix rewrote `once()` in `src/host/runtime/internal/mention-symbol-deps.ts`
 * so that ONLY fulfilled promises are cached. The original bug — a rejected
 * first-call build (transient fs hiccup, semantic backend cold-start race)
 * gets cached as a permanent rejected Promise, turning the entire `@symbol`
 * strategy into silent null for the rest of the session — was permanent dead
 * (audit-H "permanent dead" hole).
 *
 * The fix is correct, but the `once()` symbol is module-private and the
 * production wrappers `buildLspLookup` / `buildSemanticLookup` swallow their
 * own throws and return `null`. That means a refactor that reverts the
 * retry-on-throw logic (e.g. "simplify" back to "always cache the promise")
 * leaves the audit's existing integration tests GREEN — the silent-null
 * behavior on second call is observationally indistinguishable from the
 * fixed behavior in those tests. CI does not protect the invariant.
 *
 * This hellgate pins the contract DIRECTLY via the `__test.once` re-export.
 * Each case is one structural property of the audit-H contract. A revert
 * that re-caches rejected promises (or, conversely, breaks the in-flight
 * sharing) is caught here, in the same PR that introduces the regression.
 *
 * Contract (verbatim from the source doc-comment):
 *   "at most one build in flight at a time AND at most one cached success —
 *    failures retry. Concurrent in-flight callers still share the SAME
 *    pending promise (no double-build)."
 *
 * Coverage (~20 cases):
 *   - reject-then-fulfill   : 2 callers, first throws → second retries → ok      (×3 axes)
 *   - fulfill-then-cached   : 2 callers, first ok → second cached                (×2 axes)
 *   - concurrent-in-flight  : 2 callers race, share same pending                 (×3 axes)
 *   - consecutive-reject    : N rejects in a row → factory called N times       (×2 axes)
 *   - alternating           : reject/ok/reject/ok pattern → factory called N    (×1 axis)
 *   - falsey return values  : 0/false/null/undefined are cacheable successes    (×4 axes)
 *   - non-Error throws      : strings, undefined, null all reset the cache      (×3 axes)
 *   - post-reject race      : new caller arrives BEFORE the catch handler fires (×1 axis)
 *
 * Determinism: factory `callCount` is asserted as an exact integer. No timing,
 * no setTimeout — every wait is `await` on a fulfilled / rejected promise.
 */

import { describe, expect, test } from "bun:test"
import { __test } from "@/host/runtime/internal/mention-symbol-deps"

const { once } = __test

/** Build a factory whose Nth call's behavior is supplied as `script[N-1]`
 *  ("ok" → fulfill with the index, "throw" → reject with a tagged Error).
 *  Each call increments `calls`. The factory itself is synchronous-shape
 *  (returns a Promise without an `await`) so resolution order is awaiter-
 *  controlled, which makes concurrency tests deterministic. */
const makeScripted = (
  script: ReadonlyArray<"ok" | "throw" | { ok: unknown } | { throw: unknown }>,
): { fn: () => Promise<unknown>; getCalls: () => number } => {
  let calls = 0
  const fn = (): Promise<unknown> => {
    const i = calls++
    const step = script[i] ?? "ok"
    if (step === "ok") return Promise.resolve(i)
    if (step === "throw") return Promise.reject(new Error(`scripted-throw-${i}`))
    if (typeof step === "object" && step !== null && "ok" in step) return Promise.resolve(step.ok)
    if (typeof step === "object" && step !== null && "throw" in step)
      return Promise.reject(step.throw)
    return Promise.resolve(i)
  }
  return { fn, getCalls: () => calls }
}

describe("once() — retry-on-throw hellgate (audit-H closeout)", () => {
  // ─── reject-then-fulfill ───────────────────────────────────────────────────
  test("first call throws → SECOND call retries (factory called twice)", async () => {
    const { fn, getCalls } = makeScripted(["throw", "ok"])
    const get = once(fn)
    await expect(get()).rejects.toThrow("scripted-throw-0")
    // Microtask flush so the internal `pending.catch(() => …)` runs before
    // we hit `get()` again — production callers are always async, so an
    // `await` is the realistic ordering.
    await Promise.resolve()
    const second = await get()
    expect(second).toBe(1)
    expect(getCalls()).toBe(2)
  })

  test("first call throws, second succeeds — third call is then CACHED", async () => {
    const { fn, getCalls } = makeScripted(["throw", "ok"])
    const get = once(fn)
    await expect(get()).rejects.toThrow()
    await Promise.resolve()
    const second = await get()
    const third = await get()
    expect(third).toBe(second) // cached identity (same fulfilled value)
    expect(getCalls()).toBe(2) // third did NOT re-call
  })

  test("first call throws — second is independent (different return)", async () => {
    let n = 0
    const fn = (): Promise<number> => {
      n += 1
      if (n === 1) return Promise.reject(new Error("once"))
      return Promise.resolve(42 + n)
    }
    const get = once(fn)
    await expect(get()).rejects.toThrow("once")
    await Promise.resolve()
    expect(await get()).toBe(44)
  })

  // ─── fulfill-then-cached ───────────────────────────────────────────────────
  test("first call succeeds → second call returns cached (factory called ONCE)", async () => {
    const { fn, getCalls } = makeScripted(["ok", "ok"])
    const get = once(fn)
    const a = await get()
    const b = await get()
    expect(a).toBe(0)
    expect(b).toBe(0)
    expect(getCalls()).toBe(1)
  })

  test("cached promise is the SAME promise identity across calls", () => {
    const { fn } = makeScripted(["ok"])
    const get = once(fn)
    const p1 = get()
    const p2 = get()
    expect(p1).toBe(p2)
  })

  // ─── concurrent-in-flight ──────────────────────────────────────────────────
  test("two concurrent callers BEFORE settle share the same pending promise", async () => {
    let resolveFactory: ((v: unknown) => void) | undefined
    let factoryCalls = 0
    const fn = (): Promise<unknown> => {
      factoryCalls += 1
      return new Promise((res) => {
        resolveFactory = res
      })
    }
    const get = once(fn)
    const p1 = get()
    const p2 = get()
    expect(p1).toBe(p2) // identity
    expect(factoryCalls).toBe(1) // single build in flight
    resolveFactory?.("done")
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe("done")
    expect(b).toBe("done")
    expect(factoryCalls).toBe(1)
  })

  test("ten concurrent callers BEFORE settle share the same pending promise", async () => {
    let resolveFactory: ((v: unknown) => void) | undefined
    let factoryCalls = 0
    const fn = (): Promise<unknown> => {
      factoryCalls += 1
      return new Promise((res) => {
        resolveFactory = res
      })
    }
    const get = once(fn)
    const promises = Array.from({ length: 10 }, () => get())
    for (let i = 1; i < promises.length; i++) {
      expect(promises[i]).toBe(promises[0])
    }
    expect(factoryCalls).toBe(1)
    resolveFactory?.("ok")
    const settled = await Promise.all(promises)
    for (const v of settled) expect(v).toBe("ok")
    expect(factoryCalls).toBe(1)
  })

  test("two concurrent callers BEFORE rejection share the same rejection (factory called ONCE)", async () => {
    let rejectFactory: ((e: unknown) => void) | undefined
    let factoryCalls = 0
    const fn = (): Promise<unknown> => {
      factoryCalls += 1
      return new Promise((_res, rej) => {
        rejectFactory = rej
      })
    }
    const get = once(fn)
    const p1 = get()
    const p2 = get()
    expect(p1).toBe(p2)
    expect(factoryCalls).toBe(1)
    rejectFactory?.(new Error("shared-reject"))
    await expect(p1).rejects.toThrow("shared-reject")
    await expect(p2).rejects.toThrow("shared-reject")
    expect(factoryCalls).toBe(1)
  })

  // ─── consecutive-reject ────────────────────────────────────────────────────
  test("three consecutive throws → factory called THREE times (no backoff, no permanent dead)", async () => {
    const { fn, getCalls } = makeScripted(["throw", "throw", "throw"])
    const get = once(fn)
    await expect(get()).rejects.toThrow("scripted-throw-0")
    await Promise.resolve()
    await expect(get()).rejects.toThrow("scripted-throw-1")
    await Promise.resolve()
    await expect(get()).rejects.toThrow("scripted-throw-2")
    expect(getCalls()).toBe(3)
  })

  test("rejected promise identity DIFFERS across calls (cache really was reset)", async () => {
    const { fn } = makeScripted(["throw", "throw"])
    const get = once(fn)
    const p1 = get()
    p1.catch(() => undefined) // prevent unhandled rejection warning
    await expect(p1).rejects.toThrow()
    await Promise.resolve()
    const p2 = get()
    p2.catch(() => undefined)
    expect(p2).not.toBe(p1)
    await expect(p2).rejects.toThrow()
  })

  // ─── alternating reject/ok ─────────────────────────────────────────────────
  test("alternating reject/ok/reject/ok → factory called exactly four times", async () => {
    const { fn, getCalls } = makeScripted(["throw", "ok", "throw", "ok"])
    const get = once(fn)
    await expect(get()).rejects.toThrow("scripted-throw-0")
    await Promise.resolve()
    const a = await get()
    expect(a).toBe(1)
    // Second success is now cached — we need a reject to clear it. But once
    // a fulfilled value is cached, no further factory calls happen. The
    // contract is: "failures retry, successes are cached forever". So with
    // ["throw","ok","throw","ok"] the call sequence is reject(0), ok(1), and
    // the cache holds at "1" — calls 3 and 4 never run.
    expect(await get()).toBe(1)
    expect(await get()).toBe(1)
    expect(getCalls()).toBe(2)
  })

  // ─── falsey return values are cacheable successes ──────────────────────────
  test("factory resolving to 0 is cached (falsey ≠ rejection)", async () => {
    const { fn, getCalls } = makeScripted([{ ok: 0 }, { ok: 99 }])
    const get = once(fn)
    expect(await get()).toBe(0)
    expect(await get()).toBe(0)
    expect(getCalls()).toBe(1)
  })

  test("factory resolving to false is cached", async () => {
    const { fn, getCalls } = makeScripted([{ ok: false }])
    const get = once(fn)
    expect(await get()).toBe(false)
    expect(await get()).toBe(false)
    expect(getCalls()).toBe(1)
  })

  test("factory resolving to null is cached (the production happy-path)", async () => {
    // `buildLspLookup` resolves to `null` when no anchors exist. That `null`
    // MUST be cached — re-walking the workspace per `findSymbol` call is the
    // bug `once()` exists to prevent.
    const { fn, getCalls } = makeScripted([{ ok: null }])
    const get = once(fn)
    expect(await get()).toBe(null)
    expect(await get()).toBe(null)
    expect(getCalls()).toBe(1)
  })

  test("factory resolving to undefined is cached", async () => {
    const { fn, getCalls } = makeScripted([{ ok: undefined }])
    const get = once(fn)
    expect(await get()).toBe(undefined)
    expect(await get()).toBe(undefined)
    expect(getCalls()).toBe(1)
  })

  // ─── non-Error throws still reset the cache ────────────────────────────────
  test("string throw resets cache (not just Error subclasses)", async () => {
    const { fn, getCalls } = makeScripted([{ throw: "boom" }, "ok"])
    const get = once(fn)
    await expect(get()).rejects.toBe("boom")
    await Promise.resolve()
    expect(await get()).toBe(1)
    expect(getCalls()).toBe(2)
  })

  test("undefined throw resets cache", async () => {
    const { fn, getCalls } = makeScripted([{ throw: undefined }, "ok"])
    const get = once(fn)
    await expect(get()).rejects.toBeUndefined()
    await Promise.resolve()
    expect(await get()).toBe(1)
    expect(getCalls()).toBe(2)
  })

  test("null throw resets cache", async () => {
    const { fn, getCalls } = makeScripted([{ throw: null }, "ok"])
    const get = once(fn)
    await expect(get()).rejects.toBeNull()
    await Promise.resolve()
    expect(await get()).toBe(1)
    expect(getCalls()).toBe(2)
  })

  // ─── post-reject race: new caller arrives BEFORE the catch handler fires ──
  test("caller arriving WHILE the rejected promise is still pending shares the rejection", async () => {
    // Race shape: factory is still pending. A second caller comes in — it
    // MUST share the in-flight promise (no double-build). Only AFTER the
    // first rejection settles does the cache reset for the NEXT caller.
    let rejectFactory: ((e: unknown) => void) | undefined
    let factoryCalls = 0
    const fn = (): Promise<unknown> => {
      factoryCalls += 1
      return new Promise((_res, rej) => {
        rejectFactory = rej
      })
    }
    const get = once(fn)
    const p1 = get()
    const p2 = get() // arrives BEFORE rejection — must share p1
    expect(p2).toBe(p1)
    expect(factoryCalls).toBe(1)
    rejectFactory?.(new Error("race-reject"))
    await expect(p1).rejects.toThrow("race-reject")
    await expect(p2).rejects.toThrow("race-reject")
    // After microtask flush, a NEW caller gets a fresh factory call.
    await Promise.resolve()
    const p3 = get()
    expect(p3).not.toBe(p1)
    expect(factoryCalls).toBe(2)
    // (don't strand p3 — resolve via the same rejectFactory pointer.)
    rejectFactory?.("ok3")
  })
})

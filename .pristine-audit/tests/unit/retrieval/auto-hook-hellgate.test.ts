/**
 * HELLGATE — adversarial AutoHookRegistrar proofs (ADR-0273).
 *
 * Invariants under attack:
 *   (i)    `installAll` → `invalidator.invalidateAll(callbacks)` triggers
 *          the staged cache + store hooks exactly once;
 *   (ii)   one hook throwing does NOT prevent the other from running;
 *   (iii)  `UnregisterAll` removes the registrar's contributions only;
 *          subsequent `invalidateAll` calls do not see them;
 *   (iv)   a second `installAll` after teardown produces a fresh,
 *          independent disposal thunk;
 *   (v)    no `installAll` call ⇒ byte-identical to pre-ADR (the
 *          underlying invalidator registry is untouched);
 *   (vi)   `registerCacheHook(null)` is a tolerated no-op + warn;
 *   (vii)  concurrent `invalidateAll` invocations are safe (no shared
 *          mutable state on the registrar's hot path);
 *   (viii) 1000 sequential registrar lifecycles complete in bounded time;
 *   (ix)   `AutoHookError` has exactly 3 arms (closed exhaustive switch);
 *   (x)    `UnregisterAll` is idempotent — second call is a no-op.
 *
 * 12 adversarial cases — HELL-AH-01..HELL-AH-12.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { type AutoHookError, createDefaultRegistrar } from "@/retrieval/auto-hook"
import {
  clearInvalidationCallbacks,
  createDefaultInvalidator,
  listInvalidationCallbacks,
} from "@/retrieval/versioning"

/**
 * Each test starts from an empty registry. The registrar adds to the
 * process-global ADR-0266 callback list, so we reset between tests.
 */
afterEach(() => {
  clearInvalidationCallbacks()
})

/**
 * Tiny fake cache + store that record their calls. The registrar
 * duck-types on the method names — these fakes intentionally do NOT
 * implement the full ADR-0263 / ADR-0261 surfaces.
 */
const makeFakeCache = () => {
  let calls = 0
  const reasons: string[] = []
  return {
    invalidate(reason: string): number {
      calls += 1
      reasons.push(reason)
      return 0
    },
    get calls() {
      return calls
    },
    get reasons(): readonly string[] {
      return reasons
    },
  }
}

const makeFakeStore = () => {
  let calls = 0
  const deleteIds: Array<readonly string[]> = []
  return {
    async delete(ids: readonly string[]): Promise<void> {
      calls += 1
      deleteIds.push(ids)
    },
    get calls() {
      return calls
    },
    get deleteIds(): ReadonlyArray<readonly string[]> {
      return deleteIds
    },
  }
}

/** Drain `invalidateAll` over the current callback registry. */
const fire = async (): Promise<void> => {
  const inv = createDefaultInvalidator({ onCallbackError: () => {} })
  await inv.invalidateAll(listInvalidationCallbacks())
}

/**
 * Label each `AutoHookError` arm. The `switch` is exhaustive — TS refuses
 * to compile if a new arm is added without updating these cases.
 */
const labelArm = (e: AutoHookError): string => {
  switch (e.kind) {
    case "null-target":
      return `null-target:${e.which}`
    case "missing-method":
      return `missing-method:${e.which}:${e.method}`
    case "install-without-target":
      return "install-without-target"
    default: {
      const _exhaustive: never = e
      return _exhaustive
    }
  }
}

describe("auto-hook hellgate (ADR-0273)", () => {
  test("HELL-AH-01: registerCacheHook → installAll → invalidateAll triggers cache.invalidate", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    reg.registerCacheHook(cache)
    const dispose = reg.installAll(createDefaultInvalidator())
    await fire()
    expect(cache.calls).toBe(1)
    expect(cache.reasons[0]).toBe("model-tag-mismatch")
    dispose()
  })

  test("HELL-AH-02: registerStoreHook → installAll → invalidateAll triggers store.delete", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const store = makeFakeStore()
    reg.registerStoreHook(store)
    const dispose = reg.installAll(createDefaultInvalidator())
    await fire()
    expect(store.calls).toBe(1)
    expect(store.deleteIds[0]).toEqual([])
    dispose()
  })

  test("HELL-AH-03: cache + store both registered → both fire", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    const store = makeFakeStore()
    reg.registerCacheHook(cache)
    reg.registerStoreHook(store)
    const dispose = reg.installAll(createDefaultInvalidator())
    await fire()
    expect(cache.calls).toBe(1)
    expect(store.calls).toBe(1)
    dispose()
  })

  test("HELL-AH-04: cache hook throwing does NOT stop store hook", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const throwingCache = {
      invalidate(_reason: string): number {
        throw new Error("cache exploded")
      },
    }
    const store = makeFakeStore()
    reg.registerCacheHook(throwingCache)
    reg.registerStoreHook(store)
    const dispose = reg.installAll(createDefaultInvalidator())
    await fire()
    expect(store.calls).toBe(1)
    dispose()
  })

  test("HELL-AH-05: UnregisterAll → subsequent invalidateAll does not fire hooks", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    reg.registerCacheHook(cache)
    const dispose = reg.installAll(createDefaultInvalidator())
    dispose()
    await fire()
    expect(cache.calls).toBe(0)
  })

  test("HELL-AH-06: installAll twice → first dispose then second active", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    reg.registerCacheHook(cache)
    const dispose1 = reg.installAll(createDefaultInvalidator())
    dispose1()
    expect(listInvalidationCallbacks().length).toBe(0)
    const dispose2 = reg.installAll(createDefaultInvalidator())
    await fire()
    expect(cache.calls).toBe(1)
    dispose2()
  })

  test("HELL-AH-07: invalidator/registrar never installed → byte-identical (empty registry)", async () => {
    // Construct registrar, do NOT installAll. Registry must be empty.
    const _reg = createDefaultRegistrar({ onWarn: () => {} })
    expect(listInvalidationCallbacks().length).toBe(0)
    await fire()
    // No throw, no side effects — byte-identical to pre-ADR baseline.
  })

  test("HELL-AH-08: registerCacheHook(null) → no-op + warn, registry stays empty", async () => {
    const warns: string[] = []
    const reg = createDefaultRegistrar({ onWarn: (m) => warns.push(m) })
    reg.registerCacheHook(null)
    const dispose = reg.installAll(createDefaultInvalidator())
    expect(listInvalidationCallbacks().length).toBe(0)
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns.some((w) => w.toLowerCase().includes("null"))).toBe(true)
    dispose()
  })

  test("HELL-AH-09: concurrent invalidateAll runs are safe", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    reg.registerCacheHook(cache)
    const dispose = reg.installAll(createDefaultInvalidator())
    await Promise.all([fire(), fire(), fire(), fire()])
    expect(cache.calls).toBe(4)
    dispose()
  })

  test("HELL-AH-10: 1000 registrar lifecycles complete in bounded time", () => {
    const t0 = performance.now()
    for (let i = 0; i < 1000; i += 1) {
      const reg = createDefaultRegistrar({ onWarn: () => {} })
      reg.registerCacheHook({ invalidate: () => 0 })
      const off = reg.installAll(createDefaultInvalidator())
      off()
    }
    const elapsed = performance.now() - t0
    // Sanity bound — 1000 round-trips on any modern machine is sub-second.
    expect(elapsed).toBeLessThan(2000)
    expect(listInvalidationCallbacks().length).toBe(0)
  })

  test("HELL-AH-11: AutoHookError 3-arm exhaustive switch compiles + labels", () => {
    const samples: AutoHookError[] = [
      { kind: "null-target", which: "cache" },
      { kind: "missing-method", which: "store", method: "delete" },
      { kind: "install-without-target" },
    ]
    const labels = samples.map(labelArm)
    expect(labels).toEqual([
      "null-target:cache",
      "missing-method:store:delete",
      "install-without-target",
    ])
  })

  test("HELL-AH-12: cleanup tracking — UnregisterAll cleans all hooks; second call is no-op", async () => {
    const reg = createDefaultRegistrar({ onWarn: () => {} })
    const cache = makeFakeCache()
    const store = makeFakeStore()
    reg.registerCacheHook(cache)
    reg.registerStoreHook(store)
    const dispose = reg.installAll(createDefaultInvalidator())
    expect(listInvalidationCallbacks().length).toBe(2)
    dispose()
    expect(listInvalidationCallbacks().length).toBe(0)
    // Idempotent — calling again is a no-op (no throw, registry still empty).
    dispose()
    expect(listInvalidationCallbacks().length).toBe(0)
    await fire()
    expect(cache.calls).toBe(0)
    expect(store.calls).toBe(0)
  })
})

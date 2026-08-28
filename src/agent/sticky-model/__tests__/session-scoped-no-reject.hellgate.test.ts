/**
 * ★ HELLGATE (MR-08 item 2) — the session-scoped decorator honours the port's
 * NO-THROW contract even when its inner store does not.
 *
 * `port.ts` states it as an invariant, not an aspiration: "No-throw public
 * surface: every store method returns Promises that RESOLVE with a typed result
 * rather than reject." Every caller above this decorator is written to that —
 * `buildStickyModelAdapter` branches on `res.ok`, the web applier is
 * fire-and-forget and "no-throw by contract", `/model` and `/sticky-model` print
 * `res.message`. None of them wraps the call in a `try`.
 *
 * MEASURED PRE-FIX: `sessionScopedStickyModelStore({inner}).set(…)` with an inner
 * store whose `set` THREW rejected the returned promise. The decorator's
 * `serialized` helper kept the write CHAIN healthy (`then(work, work)` + a
 * `.catch` on the tail) but did nothing for the caller's promise — so the
 * fire-and-forget web applier produced an unhandled rejection and the CLI
 * surfaces got an exception where their typed `ok:false` branch was waiting.
 *
 * INERT AGAINST TODAY'S PRODUCTION WIRING, deliberately: the fs impl catches
 * everything and the port is the only thing between this decorator and a future
 * impl that does not. A contract nothing enforces is a contract the next store
 * breaks silently — the cases below are the enforcement.
 *
 * RED-on-injection (verified, restored from a `cp` backup): delete the
 * `try/catch` around `args.inner.set` in `session-scoped-store.ts` ⇒ THROW-1
 * and CHAIN-1 red with the raw `boom` rejection; the same for `unset` ⇒ THROW-2.
 */

import { describe, expect, test } from "bun:test"
import { QuantaError } from "@/shared"
import {
  type StickyModelKey,
  type StickyModelSetResult,
  type StickyModelStore,
  StickyModelWriteError,
  sessionScopedStickyModelStore,
} from ".."

const KEY: StickyModelKey = { mode: "default", provider: "openai" }
const OTHER: StickyModelKey = { mode: "plan", provider: "openai" }

/** An inner store whose mutating methods THROW on demand — the contract
 *  violation this decorator now absorbs. `calls` proves the chain kept running
 *  after one member blew up. */
const throwingInner = (
  shouldThrow: (input: StickyModelKey) => boolean,
): { store: StickyModelStore; calls: string[]; disk: Map<string, string> } => {
  const disk = new Map<string, string>()
  const calls: string[] = []
  const keyOf = (i: StickyModelKey): string => `${i.provider ?? ""}:${i.mode}`
  const store: StickyModelStore = {
    get: async (i) => disk.get(keyOf(i)),
    peek: (i) => disk.get(keyOf(i)),
    load: async () => ({ ok: true, snapshot: Object.fromEntries(disk) }),
    set: async (i) => {
      calls.push(`set:${i.mode}`)
      if (shouldThrow(i)) throw new Error("boom: inner store exploded")
      disk.set(keyOf(i), i.modelId)
      return { ok: true }
    },
    unset: async (i) => {
      calls.push(`unset:${i.mode}`)
      if (shouldThrow(i)) throw new Error("boom: inner store exploded")
      disk.delete(keyOf(i))
      return { ok: true }
    },
  }
  return { store, calls, disk }
}

describe("MR-08 · session-scoped sticky store honours the no-throw contract", () => {
  test("THROW-1: an inner `set` that THROWS resolves to a typed ok:false", async () => {
    const inner = throwingInner(() => true)
    const store = sessionScopedStickyModelStore({ inner: inner.store, seed: {} })
    // The assertion is on the RESOLUTION, not on a caught exception — a test that
    // `await`ed inside a `try` would pass on either behaviour.
    const res: StickyModelSetResult = await store.set({ ...KEY, modelId: "model-a" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected a typed failure")
    expect(res.error).toBeInstanceOf(QuantaError)
    expect(res.error).toBeInstanceOf(StickyModelWriteError)
    // The operator has to be able to tell WHAT failed from the message alone.
    expect(res.error.message).toContain("boom: inner store exploded")
    // …and the cell is untouched, exactly as it is for a returned `ok:false`, so
    // no display claims a model this session will not run.
    expect(store.peek(KEY)).toBeUndefined()
    expect(await store.get(KEY)).toBeUndefined()
  })

  test("THROW-2: an inner `unset` that THROWS resolves to a typed ok:false and keeps the pick", async () => {
    const inner = throwingInner((i) => i.mode === "default")
    const store = sessionScopedStickyModelStore({
      inner: inner.store,
      seed: { "openai:default": "model-a" },
    })
    const res = await store.unset(KEY)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected a typed failure")
    expect(res.error).toBeInstanceOf(StickyModelWriteError)
    // A removal the durable store refused must NOT clear the cell — otherwise the
    // session drops to the boot model while the file still holds the pick and the
    // next session silently resurrects it.
    expect(store.peek(KEY)).toBe("model-a")
  })

  test("CHAIN-1: a throwing write does not wedge the chain — the NEXT write proceeds", async () => {
    // The write chain is what orders concurrent picks. A rejection that poisoned
    // its tail would hang every later `/model` in the session — a worse failure
    // than the one being fixed, so it gets its own case.
    const inner = throwingInner((i) => i.mode === "default")
    const store = sessionScopedStickyModelStore({ inner: inner.store, seed: {} })
    const [bad, good] = await Promise.all([
      store.set({ ...KEY, modelId: "model-a" }),
      store.set({ ...OTHER, modelId: "model-b" }),
    ])
    expect(bad.ok).toBe(false)
    expect(good.ok).toBe(true)
    expect(inner.calls).toEqual(["set:default", "set:plan"])
    expect(store.peek(OTHER)).toBe("model-b")
    expect(store.peek(KEY)).toBeUndefined()
    // And a write enqueued AFTER the failure still lands, in order.
    expect((await store.set({ ...OTHER, modelId: "model-c" })).ok).toBe(true)
    expect(store.peek(OTHER)).toBe("model-c")
    expect(inner.disk.get("openai:plan")).toBe("model-c")
  })

  test("CHAIN-2: three throwing writes in a row each resolve, none rejects", async () => {
    const inner = throwingInner(() => true)
    const store = sessionScopedStickyModelStore({ inner: inner.store, seed: {} })
    const results = await Promise.all([
      store.set({ ...KEY, modelId: "a" }),
      store.unset(OTHER),
      store.set({ ...OTHER, modelId: "b" }),
    ])
    expect(results.map((r) => r.ok)).toEqual([false, false, false])
    expect(inner.calls).toEqual(["set:default", "unset:plan", "set:plan"])
  })

  test("CONTROL-1: a returned ok:false behaves identically (the shape being matched)", async () => {
    // Paired control. The whole change is "a throw becomes the ok:false the port
    // already promised", so the two paths must be indistinguishable to a caller.
    const refusing: StickyModelStore = {
      get: async () => undefined,
      peek: () => undefined,
      load: async () => ({ ok: true, snapshot: {} }),
      set: async () => ({
        ok: false,
        error: new StickyModelWriteError("/tmp/nope/sticky-model.json", "disk full"),
      }),
      unset: async () => ({
        ok: false,
        error: new StickyModelWriteError("/tmp/nope/sticky-model.json", "disk full"),
      }),
    }
    const store = sessionScopedStickyModelStore({ inner: refusing, seed: {} })
    const res = await store.set({ ...KEY, modelId: "model-a" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected a typed failure")
    expect(res.error).toBeInstanceOf(StickyModelWriteError)
    expect(store.peek(KEY)).toBeUndefined()
  })

  test("CONTROL-2: a HEALTHY inner store is byte-identical — no wrapper in the way", async () => {
    const inner = throwingInner(() => false)
    const store = sessionScopedStickyModelStore({ inner: inner.store, seed: {} })
    expect(await store.set({ ...KEY, modelId: "model-a" })).toEqual({ ok: true })
    expect(store.peek(KEY)).toBe("model-a")
    expect(await store.unset(KEY)).toEqual({ ok: true })
    expect(store.peek(KEY)).toBeUndefined()
  })
})

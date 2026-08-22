import { describe, expect, test } from "bun:test"
import { resolveStickyModelStore } from "../../../src/host/runtime/agent-arg-builder"

/**
 * jun-11 (#4) — `/model` interactive picker wired OUT OF THE BOX.
 *
 * Before: `resolveStickyModelStore(undefined)` returned `undefined` ⇒ no
 * `stickyModelStore` slot on AgentConfig ⇒ `buildModelAdapterWire` returned `{}`
 * ⇒ `ctx.model` absent ⇒ `/model` printed "not wired in this surface" unless the
 * `--sticky-model` flag was passed. Now the default is an IN-MEMORY store so
 * `/model` switches the model in-session, while `--sticky-model` still upgrades
 * to the fs-backed store for cross-session persistence.
 *
 * The two consume legs (`config.stickyModelStore` read per-turn by
 * `skill-gate#readStickyModelForMode`, and `ctx.model` SET via
 * `buildModelAdapterWire`) both read the SAME `runtimeContext.stickyModelStore()`
 * instance, so a `/model` SET to this store actually changes the per-turn model
 * (not a half-wire). This pins the default-store behavior the wiring rides on.
 *
 * RED before the in-memory default (the first `toBeDefined` failed); GREEN after.
 */
describe("resolveStickyModelStore (jun-11 #4 — /model wired by default)", () => {
  test("WITHOUT --sticky-model returns a usable in-session store (was undefined)", async () => {
    const r = resolveStickyModelStore(undefined)
    expect(r).toBeDefined()
    const store = r?.store
    if (store === undefined) throw new Error("expected a default in-memory store")
    // Round-trips in-process, so a `/model` SET actually changes the per-turn model.
    const set = await store.set({ mode: "default", modelId: "gpt-5.4" })
    expect(set.ok).toBe(true)
    expect(await store.get({ mode: "default" })).toBe("gpt-5.4")
  })

  test("empty store falls back (get → undefined): byte-identical for surfaces that never /model", async () => {
    const r = resolveStickyModelStore(false)
    const store = r?.store
    if (store === undefined) throw new Error("expected a default store")
    expect(await store.get({ mode: "default" })).toBeUndefined()
  })

  test("each no-flag call returns a FRESH store (session-scoped, no cross-session leak)", async () => {
    const a = resolveStickyModelStore(false)?.store
    const b = resolveStickyModelStore(false)?.store
    if (a === undefined || b === undefined) throw new Error("expected default stores")
    await a.set({ mode: "default", modelId: "model-a" })
    expect(await b.get({ mode: "default" })).toBeUndefined()
  })

  test("WITH --sticky-model returns a defined (fs-backed) store for persistence", () => {
    expect(resolveStickyModelStore(true)).toBeDefined()
  })
})

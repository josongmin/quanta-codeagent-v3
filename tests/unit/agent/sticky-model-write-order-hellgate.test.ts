/**
 * ★ HELLGATE — concurrent picks cannot leave the cell and the disk disagreeing
 * (aug-28).
 *
 * `sessionScopedStickyModelStore` writes THROUGH to the durable store and then
 * reflects the pick in its in-memory cell — the cell being what this session's
 * turns read (`get`) and what every display reads (`peek`). Both steps happen per
 * call, and nothing ordered the calls against each other.
 *
 * The web surface can issue them concurrently: `applyModel` is FIRE-AND-FORGET by
 * contract (the control-request applier is sync and must not throw), so two
 * `set_model` frames in one drain start two overlapping writes. If their durable
 * writes land in one order and their promises resolve in the other — a slow
 * `rename(2)` is enough — the file ends up naming one model and the cell the
 * other. The session then runs B while the NEXT session boots A, with nothing
 * anywhere reporting a conflict. That is the same "displays disagree with the
 * turn" failure this whole campaign is about, one axis over.
 *
 * MEASURED before the fix, with the double below (A lands on disk last but
 * resolves first): `disk=A cell=B`. Natural fs timing did NOT reproduce it
 * (0/25 runs), which is exactly why the guard forces the interleaving instead of
 * racing real IO and calling a green run proof.
 *
 * The fix is to SERIALIZE the write-through: each `set`/`unset` awaits the
 * previous one, so the last call enqueued is the last on disk AND the last in the
 * cell. Ordering, not locking — a rejected write still leaves the cell untouched.
 *
 * RED-on-injection: drop the chaining in `session-scoped-store.ts` ⇒ case 1 fails
 * with `disk=A cell=B`.
 */

import { describe, expect, test } from "bun:test"
import {
  type StickyModelKey,
  type StickyModelStore,
  sessionScopedStickyModelStore,
} from "@/agent/sticky-model"

const KEY: StickyModelKey = { mode: "default", provider: "openai" }

/** A durable double whose writes resolve in the OPPOSITE order to their effect —
 *  the shape a slow rename produces, made deterministic. Records the disk value
 *  and the order writes were APPLIED. */
const invertedStore = () => {
  const applied: string[] = []
  let disk: string | undefined
  const inner: StickyModelStore = {
    get: async () => disk,
    peek: () => disk,
    load: async () => ({
      ok: true,
      snapshot: disk === undefined ? {} : { "openai:default": disk },
    }),
    unset: async () => {
      disk = undefined
      applied.push("unset")
      return { ok: true } as const
    },
    set: async (input) => {
      await new Promise((r) => setTimeout(r, input.modelId === "A" ? 30 : 5))
      disk = input.modelId
      applied.push(input.modelId)
      // The later-applied write also takes longer to SETTLE, so without ordering
      // the earlier-applied one resolves last and wins the cell.
      if (input.modelId === "B") await new Promise((r) => setTimeout(r, 50))
      return { ok: true } as const
    },
  }
  return { inner, applied, disk: () => disk }
}

describe("concurrent sticky writes keep the cell and the durable store in step", () => {
  test("1. two overlapping picks: the cell names whatever the DISK names", async () => {
    const d = invertedStore()
    const store = sessionScopedStickyModelStore({ inner: d.inner, seed: {} })
    await Promise.all([store.set({ ...KEY, modelId: "A" }), store.set({ ...KEY, modelId: "B" })])
    expect(store.peek(KEY)).toBe(d.disk() as string)
    // …and `get` (what the turn reads) agrees with `peek` (what displays read).
    expect(await store.get(KEY)).toBe(d.disk() as string)
  })

  test("2. the LAST pick enqueued is the one that wins, on both", async () => {
    // Ordering, not just agreement: an operator who types two picks expects the
    // second. Agreement alone would be satisfied by both ending up on the first.
    const d = invertedStore()
    const store = sessionScopedStickyModelStore({ inner: d.inner, seed: {} })
    await Promise.all([store.set({ ...KEY, modelId: "A" }), store.set({ ...KEY, modelId: "B" })])
    expect(d.applied).toEqual(["A", "B"])
    expect(store.peek(KEY)).toBe("B")
  })

  test("3. a clear racing a set is ordered too (not just set-vs-set)", async () => {
    const d = invertedStore()
    const store = sessionScopedStickyModelStore({ inner: d.inner, seed: {} })
    await Promise.all([store.set({ ...KEY, modelId: "A" }), store.unset(KEY)])
    expect(d.applied).toEqual(["A", "unset"])
    expect(store.peek(KEY)).toBeUndefined()
    expect(d.disk()).toBeUndefined()
  })

  test("4. paired control — a REJECTED write still leaves the cell untouched", async () => {
    const failing: StickyModelStore = {
      get: async () => undefined,
      peek: () => undefined,
      load: async () => ({ ok: true, snapshot: {} }),
      unset: async () => ({ ok: true }) as const,
      set: async () =>
        ({ ok: false, error: new Error("disk full") as never }) as unknown as { ok: false },
    }
    const store = sessionScopedStickyModelStore({ inner: failing as StickyModelStore, seed: {} })
    const res = await store.set({ ...KEY, modelId: "A" })
    expect(res.ok).toBe(false)
    expect(store.peek(KEY)).toBeUndefined()
  })
})

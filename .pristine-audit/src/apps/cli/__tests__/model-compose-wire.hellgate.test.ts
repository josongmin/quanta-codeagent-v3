/**
 * Hellgate — `/model` compose-seam mode-binding (ticket 14, §11.6).
 *
 * PINS the REAL FIX (R1-3): the surface-compose model-adapter wire binds the
 * SET to the SAME mode derivation the loop's consume side reads
 * (`resolveAgentMode(undefined, planMode)`), NOT the literal `"default"`. The
 * inline IIFE had NO test driving it, so the fix could silently revert to
 * `() => "default"` and stay green — a `/model` set under `--plan` would then
 * phantom onto the `'default'` key the loop never reads at plan time.
 *
 * This drives `buildModelAdapterWire` — the smallest REAL seam that builds the
 * modelAdapter the compose IIFE installs — with `planMode:true` + a live
 * in-memory sticky store (the SAME store type the loop reads), calls
 * `modelAdapter.set(id)`, and asserts the write landed on the `'plan'` key. If
 * `currentMode` reverts to `() => "default"`, the write lands on `'default'`
 * and the `'plan'` assertion goes RED.
 */
import { describe, expect, test } from "bun:test"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import { buildModelAdapterWire } from "../repl/surface-compose"

describe("model compose wire — mode-implicit SET binding (REAL FIX R1-3)", () => {
  test("under planMode:true a SET lands on the 'plan' key (NOT 'default')", async () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      bootModel: "gpt-5",
      planMode: true,
      candidateIds: ["gpt-5", "gpt-4o"],
    })
    const adapter = wire.modelAdapter
    expect(adapter).toBeDefined()

    const out = await adapter?.set("gpt-4o")
    expect(out).toBe("ok")

    // The fix: the SET targets the SAME mode the loop reads under --plan.
    expect(await store.get({ mode: "plan" })).toBe("gpt-4o")
    // And NOT the 'default' key (the reverted `() => "default"` failure mode).
    expect(await store.get({ mode: "default" })).toBeUndefined()
  })

  test("under planMode:false a SET lands on the 'default' key", async () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      bootModel: "gpt-5",
      planMode: false,
      candidateIds: ["gpt-5", "gpt-4o"],
    })
    const out = await wire.modelAdapter?.set("gpt-4o")
    expect(out).toBe("ok")
    expect(await store.get({ mode: "default" })).toBe("gpt-4o")
    expect(await store.get({ mode: "plan" })).toBeUndefined()
  })

  test("absent sticky store ⇒ adapter omitted (slot absent ⇒ `/model` not wired)", () => {
    const wire = buildModelAdapterWire({
      stickyStore: undefined,
      bootModel: "gpt-5",
      planMode: false,
      candidateIds: ["gpt-5"],
    })
    expect(wire.modelAdapter).toBeUndefined()
    expect("modelAdapter" in wire).toBe(false)
  })

  test("candidateIds flow through to the picker candidates() verbatim", () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      bootModel: "gpt-5",
      planMode: false,
      candidateIds: ["gpt-5", "gpt-4o"],
    })
    const ids = wire.modelAdapter?.candidates().map((m) => m.id)
    expect(ids).toEqual(["gpt-5", "gpt-4o"])
  })
})

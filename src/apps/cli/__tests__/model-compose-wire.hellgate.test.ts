/**
 * Hellgate — `/model` compose-seam mode-binding (ticket 14, §11.6; corrected aug-28).
 *
 * aug-28 CORRECTION. This file used to drive `planMode` and assert the key, which
 * encoded a FALSE premise: the loop's consume side is `resolveLiveAgentMode`, which
 * prefers the LIVE `agentModeState` cell (the CLI's shift+tab mode cycle, seeded
 * default-ON) over `planMode`. So the wire now takes THE mode getter
 * (`sticky-model-boot#liveAgentMode`) and these cases pin BOTH arms: the live cell
 * wins when present, `planMode` decides when it is absent. Driving `planMode`
 * alone could not fail for the reason the old test names claimed.
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
import { fakeModelRouting } from "../../../../tests/_support/fake-model-routing"
import { liveAgentMode } from "../repl/sticky-model-boot"
import { buildModelAdapterWire } from "../repl/surface-compose"

describe("model compose wire — mode-implicit SET binding (REAL FIX R1-3)", () => {
  test("under planMode:true (no live cell) a SET lands on the 'plan' key (NOT 'default')", async () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      routing: fakeModelRouting({
        bootModelId: "gpt-5",
        ids: ["gpt-5", "gpt-4o"],
        mode: liveAgentMode({ planMode: true }),
        store,
      }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: true }),
      candidateIds: () => ["gpt-5", "gpt-4o"],
    })
    const adapter = wire.modelAdapter
    expect(adapter).toBeDefined()

    const out = await adapter?.set("gpt-4o")
    expect(out).toBe("ok")

    // The fix: the SET targets the SAME mode the loop reads under --plan.
    expect(await store.get({ mode: "plan", provider: "openai" })).toBe("gpt-4o")
    // And NOT the 'default' key (the reverted `() => "default"` failure mode).
    expect(await store.get({ mode: "default", provider: "openai" })).toBeUndefined()
  })

  test("under planMode:false a SET lands on the 'default' key", async () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      routing: fakeModelRouting({
        bootModelId: "gpt-5",
        ids: ["gpt-5", "gpt-4o"],
        mode: liveAgentMode({ planMode: true }),
        store,
      }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: false }),
      candidateIds: () => ["gpt-5", "gpt-4o"],
    })
    const out = await wire.modelAdapter?.set("gpt-4o")
    expect(out).toBe("ok")
    expect(await store.get({ mode: "default", provider: "openai" })).toBe("gpt-4o")
    expect(await store.get({ mode: "plan", provider: "openai" })).toBeUndefined()
  })

  test("absent sticky store ⇒ adapter omitted (slot absent ⇒ `/model` not wired)", () => {
    const wire = buildModelAdapterWire({
      stickyStore: undefined,
      routing: fakeModelRouting({ bootModelId: "gpt-5", ids: ["gpt-5"] }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: false }),
      candidateIds: () => ["gpt-5"],
    })
    expect(wire.modelAdapter).toBeUndefined()
    expect("modelAdapter" in wire).toBe(false)
  })

  test("aug-28 — the LIVE cell wins over planMode: shift+tab to PLAN keys the SET 'plan'", async () => {
    const store = inMemoryStickyModelStore()
    // A session launched WITHOUT --plan whose operator pressed shift+tab onto the
    // PLAN rung: `planMode` is false, but the loop reads `agentModeState`, so the
    // write must key `plan` — the old static derivation keyed `default` and the
    // pick silently never applied.
    const cell = { current: () => ({ agentMode: "plan" as const }) }
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      routing: fakeModelRouting({
        bootModelId: "gpt-5",
        ids: ["gpt-5", "gpt-4o"],
        mode: liveAgentMode({ planMode: true }),
        store,
      }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: false, agentModeCell: cell }),
      candidateIds: () => ["gpt-5", "gpt-4o"],
    })
    expect(await wire.modelAdapter?.set("gpt-4o")).toBe("ok")
    expect(await store.get({ mode: "plan", provider: "openai" })).toBe("gpt-4o")
    expect(await store.get({ mode: "default", provider: "openai" })).toBeUndefined()
  })

  test("aug-28 — and the reverse: --plan with the cell on the DEFAULT rung keys 'default'", async () => {
    const store = inMemoryStickyModelStore()
    // The `--plan` launch case that used to key `plan` while the loop read the
    // cycle's rung. (The surface now also SEEDS the rung from `--plan`, so in
    // production these agree; this pins the resolver's precedence itself.)
    const cell = { current: () => ({ agentMode: "default" as const }) }
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      routing: fakeModelRouting({
        bootModelId: "gpt-5",
        ids: ["gpt-5", "gpt-4o"],
        mode: liveAgentMode({ planMode: true }),
        store,
      }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: true, agentModeCell: cell }),
      candidateIds: () => ["gpt-5", "gpt-4o"],
    })
    expect(await wire.modelAdapter?.set("gpt-4o")).toBe("ok")
    expect(await store.get({ mode: "default", provider: "openai" })).toBe("gpt-4o")
    expect(await store.get({ mode: "plan", provider: "openai" })).toBeUndefined()
  })

  test("candidateIds flow through to the picker candidates() verbatim", () => {
    const store = inMemoryStickyModelStore()
    const wire = buildModelAdapterWire({
      stickyStore: { store },
      routing: fakeModelRouting({
        bootModelId: "gpt-5",
        ids: ["gpt-5", "gpt-4o"],
        mode: liveAgentMode({ planMode: true }),
        store,
      }).routing,
      bootModel: "gpt-5",
      currentMode: liveAgentMode({ planMode: false }),
      candidateIds: () => ["gpt-5", "gpt-4o"],
    })
    const ids = wire.modelAdapter?.candidates().map((m) => m.id)
    expect(ids).toEqual(["gpt-5", "gpt-4o"])
  })
})

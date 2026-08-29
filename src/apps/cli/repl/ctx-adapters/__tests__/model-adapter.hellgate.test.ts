/**
 * Hellgate — `/model` ctx-adapter projection (ticket 14, §11.6). GREEN now —
 * the adapter is host glue, independent of slash registration.
 *
 * Coverage:
 *   - candidates() enriches each id from the provider-metadata SSOT (window /
 *     output / recommended-badge-on-boot / capability hint), degrading for an
 *     un-tabled id;
 *   - current() returns the host getter's value, falling back to the boot model;
 *   - set() persists to the sticky store keyed to the CURRENT mode (mode-implicit)
 *     and forwards the store's typed outcome;
 *   - set() rejects an unknown mode + an empty id;
 *   - effortSupport() forwards the metadata SSOT.
 */
import { describe, expect, test } from "bun:test"
import type { AgentMode } from "@/agent"
import { createModelRoutingAuthority } from "@/agent/model-routing/authority"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import { buildModelAdapter } from "../model-adapter"

/** MR-02 — the adapter now reads and mutates through the ROUTING AUTHORITY, not
 *  the store. It used to poke the store directly, which made it a second owner of
 *  the selection: `/model --clear` cleared the store while the authority still
 *  held the pick and `current()` kept announcing it. The harness therefore builds
 *  a REAL authority over an in-memory store, so these cases exercise the same
 *  precedence/validation path production does. */
const build = (over?: {
  mode?: AgentMode
  current?: () => string
  ids?: readonly string[]
  modeRef?: { value: AgentMode }
}) => {
  const store = inMemoryStickyModelStore()
  const ids = over?.ids ?? ["gpt-5", "gpt-4o", "future-xyz"]
  const modeOf = (): AgentMode => over?.modeRef?.value ?? over?.mode ?? "default"
  const ports = new Map(
    ids.filter((id) => id !== "gpt-5").map((id) => [id, { model: id } as never]),
  )
  const routing = createModelRoutingAuthority({
    store,
    catalog: {
      candidates: [...ports].map(([id, port]) => ({ id, port })),
      ids: () => ids,
      refresh: async () => undefined,
    },
    provider: "openai",
    bootModelId: "gpt-5",
    bootPort: { model: "gpt-5" } as never,
    mode: modeOf,
    pinned: false,
    admitted: new Map(),
  })
  const adapter = buildModelAdapter({
    routing,
    bootModel: "gpt-5",
    currentMode: modeOf,
    provider: "openai",
    candidateIds: () => ids,
    ...(over?.current !== undefined ? { currentModel: over.current } : {}),
  })
  return { store, adapter, routing }
}

describe("model-adapter — candidate projection from the metadata SSOT", () => {
  test("boot model gets the recommended badge + window + reasoning hint", () => {
    const { adapter } = build()
    const gpt5 = adapter.candidates().find((m) => m.id === "gpt-5")
    expect(gpt5).toBeDefined()
    expect(gpt5?.contextWindow).toBe(400_000)
    expect(gpt5?.maxOutput).toBe(128_000)
    expect(gpt5?.recommended).toBe(true)
    expect(gpt5?.hint).toBe("most capable")
  })

  test("non-boot reasoning-less model: no badge, 'lower cost' hint", () => {
    const { adapter } = build()
    const gpt4o = adapter.candidates().find((m) => m.id === "gpt-4o")
    expect(gpt4o?.recommended).toBeUndefined()
    expect(gpt4o?.contextWindow).toBe(128_000)
    expect(gpt4o?.hint).toContain("lower cost")
  })

  test("FAMILY-FALLBACK id gets a window but NO hint (the exact-metadata rule)", () => {
    // The rule `deriveHint` exists for: both metadata resolvers fall back to a
    // per-FAMILY entry, so a live-catalog id no table knows (`gpt-5.4-mini`,
    // `gpt-5.3-codex-spark`) resolved through the `gpt-5` family and every picker
    // row printed the same "most capable" — a badge that is actively WRONG on a
    // mini/spark model. A hint is a claim about the SPECIFIC model, so it is
    // emitted only for an exact metadata entry; the window/output columns keep the
    // family estimate, which is merely approximate rather than false.
    //
    // Measured: `gpt-5.4-mini` → exact=false, family=true, window=400000. The
    // suite previously covered only exact-tabled ids and a fully un-tabled one, so
    // reverting the guard left it green — this is the case that discriminates.
    const { adapter } = build({ ids: ["gpt-5", "gpt-5.4-mini"] })
    const mini = adapter.candidates().find((m) => m.id === "gpt-5.4-mini")
    expect(mini).toBeDefined()
    expect(mini?.contextWindow).toBe(400_000)
    expect(mini?.hint).toBeUndefined()
    // Paired control: the EXACT-tabled sibling in the same family still gets one.
    expect(adapter.candidates().find((m) => m.id === "gpt-5")?.hint).toBe("most capable")
  })

  test("un-tabled id degrades: bare id, no window/hint fields", () => {
    const { adapter } = build()
    const xyz = adapter.candidates().find((m) => m.id === "future-xyz")
    expect(xyz).toBeDefined()
    expect(xyz?.contextWindow).toBeUndefined()
    expect(xyz?.maxOutput).toBeUndefined()
    expect(xyz?.hint).toBeUndefined()
    expect(xyz?.recommended).toBeUndefined()
  })

  test("candidate ids are deduped with the boot model first", () => {
    const { adapter } = build({ ids: ["gpt-5", "gpt-5", "gpt-4o"] }) // dup boot + dup
    const ids = adapter.candidates().map((m) => m.id)
    expect(ids).toEqual(["gpt-5", "gpt-4o"])
  })
})

describe("model-adapter — current()", () => {
  test("returns the host getter's value when supplied", () => {
    const { adapter } = build({ current: () => "gpt-4o" })
    expect(adapter.current()).toBe("gpt-4o")
  })
  test("falls back to the boot model when no getter", () => {
    const { adapter } = build()
    expect(adapter.current()).toBe("gpt-5")
  })

  // ticket-14 REAL FIX #1 — the sticky store is ASYNC (get/set return promises)
  // but current() is SYNC, so a `currentModel` getter reading the store can't
  // reflect a set (it would return a Promise). The adapter keeps a per-mode SYNC
  // SHADOW its own set() updates, so an in-surface set is visible to current()
  // IMMEDIATELY — with NO host getter at all (the surface-compose wiring).
  test("set is reflected by current() with NO host getter (sync shadow)", async () => {
    // Build EXACTLY as surface-compose does: no `currentModel` getter supplied.
    const { adapter } = build()
    expect(adapter.current()).toBe("gpt-5") // boot anchor before any set
    await adapter.set("gpt-4o")
    expect(adapter.current()).toBe("gpt-4o") // sync shadow reflects the set
  })

  test("current() is keyed to the active mode (no cross-mode leak)", async () => {
    const modeRef: { value: AgentMode } = { value: "default" }
    const { adapter } = build({ modeRef, ids: ["gpt-5", "gpt-4o"] })
    // Set under `default` — only the default-mode selection is populated.
    await adapter.set("gpt-4o")
    expect(adapter.current()).toBe("gpt-4o")
    // Switch the active mode to `plan` — that key has no selection ⇒ boot anchor,
    // NOT the default-mode set (no cross-mode leak).
    modeRef.value = "plan"
    expect(adapter.current()).toBe("gpt-5")
    // A set under `plan` populates only the plan selection.
    await adapter.set("gpt-4o")
    expect(adapter.current()).toBe("gpt-4o")
    // Back to default — its own earlier selection is intact.
    modeRef.value = "default"
    expect(adapter.current()).toBe("gpt-4o")
  })
})

describe("model-adapter — set() persists to the sticky store (mode-implicit)", () => {
  test("set writes the CURRENT mode's entry + returns 'ok'", async () => {
    const { store, adapter } = build({ mode: "plan" })
    const out = await adapter.set("gpt-4o")
    expect(out).toBe("ok")
    const got = await store.get({ mode: "plan", provider: "openai" })
    expect(got).toBe("gpt-4o")
    // A different mode is untouched.
    expect(await store.get({ mode: "default", provider: "openai" })).toBeUndefined()
  })

  test("empty id ⇒ write-error (consume side treats empty as 'no override')", async () => {
    const { adapter } = build()
    const out = await adapter.set("   ")
    expect(out).not.toBe("ok")
    expect((out as { kind: string }).kind).toBe("write-error")
  })

  test("effortSupport forwards the metadata SSOT", () => {
    const { adapter } = build()
    expect(adapter.effortSupport("gpt-5")?.reasoning).toBe(true)
    expect(adapter.effortSupport("gpt-4o")?.reasoning).toBe(false)
    expect(adapter.effortSupport("totally-unknown")).toBeUndefined()
  })
})

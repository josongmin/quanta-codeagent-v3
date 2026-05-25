/**
 * Per-thread dynamic-tools hellgate (ADR-0206).
 *
 * Seals 15 invariants:
 *   TT-01 register / list round-trip
 *   TT-02 duplicate name → Err("duplicate-tool") with existing payload
 *   TT-03 list on unknown threadId → []
 *   TT-04 resolve unknown name → Err("not-found")
 *   TT-05 deferLoading=false → factory runs eagerly at register
 *   TT-06 deferLoading=true → first resolve runs factory, 2nd cached
 *   TT-07 cross-thread isolation
 *   TT-08 evictNamespace(tid, ns) drops only that namespace
 *   TT-09 evict(tid) drops every spec in that thread
 *   TT-10 composer: per-thread name wins over global name
 *   TT-11 factory throws → Err("factory-failed", { cause })
 *   TT-12 concurrent resolve x2 on deferred → factory exactly once
 *   TT-13 list default excludes deferred-not-yet-resolved entries
 *   TT-14 returned spec is frozen (mutation throws in strict mode)
 *   TT-15 1000 registrations → list returns all 1000
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { composeTools, type DynamicToolSpec, inMemoryThreadToolStore } from "@/agent/thread-tools"
import type { Tool, ToolEvent } from "@/tool"

// ----------------------------------------------------------------------------
// harness
// ----------------------------------------------------------------------------

const mkTool = (name: string, marker?: string): Tool => {
  const m = marker ?? name
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: `${m}-ran` } }
    },
  }
}

const mkSpec = (
  name: string,
  deferLoading: boolean,
  factory: () => Tool,
  namespace?: string,
): DynamicToolSpec => {
  const base = {
    name,
    description: `${name} desc`,
    inputSchema: { type: "object" } as object,
    deferLoading,
    factory,
  }
  return namespace !== undefined ? { ...base, namespace } : base
}

// ----------------------------------------------------------------------------
// TT-01 .. TT-15
// ----------------------------------------------------------------------------

describe("per-thread dynamic tools hellgate (ADR-0206)", () => {
  test("HELL-TT-01: register + list round-trip", () => {
    const store = inMemoryThreadToolStore()
    const spec = mkSpec("alpha", false, () => mkTool("alpha"))
    const r = store.register("tid-1", spec)
    expect(r.ok).toBe(true)
    const list = store.list("tid-1")
    expect(list.length).toBe(1)
    expect(list[0]?.name).toBe("alpha")
  })

  test("HELL-TT-02: duplicate name → Err('duplicate-tool', { existing })", () => {
    const store = inMemoryThreadToolStore()
    const first = mkSpec("dup", false, () => mkTool("dup-first"))
    const second = mkSpec("dup", false, () => mkTool("dup-second"))
    expect(store.register("tid", first).ok).toBe(true)
    const r2 = store.register("tid", second)
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.code).toBe("duplicate-tool")
    if (r2.error.code !== "duplicate-tool") throw new Error("unreachable")
    expect(r2.error.existing.name).toBe("dup")
    expect(r2.error.existing.description).toBe("dup desc")
    // Registry state unchanged — still only 1 entry under that name.
    expect(store.list("tid").length).toBe(1)
  })

  test("HELL-TT-03: list on unknown threadId → [] (no throw)", () => {
    const store = inMemoryThreadToolStore()
    const out = store.list("ghost-thread")
    expect(out).toEqual([])
    expect(Array.isArray(out)).toBe(true)
  })

  test("HELL-TT-04: resolve unknown tool → Err('not-found')", () => {
    const store = inMemoryThreadToolStore()
    const r = store.resolve("tid", "no-such-tool")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("not-found")
  })

  test("HELL-TT-05: deferLoading=false → factory runs at register time", () => {
    const store = inMemoryThreadToolStore()
    let calls = 0
    const spec = mkSpec("eager", false, () => {
      calls += 1
      return mkTool("eager")
    })
    expect(store.register("tid", spec).ok).toBe(true)
    expect(calls).toBe(1)
    // Subsequent resolve does NOT re-run the factory.
    const r = store.resolve("tid", "eager")
    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
  })

  test("HELL-TT-06: deferLoading=true → first resolve runs factory, second cached", () => {
    const store = inMemoryThreadToolStore()
    let calls = 0
    const spec = mkSpec("lazy", true, () => {
      calls += 1
      return mkTool("lazy")
    })
    expect(store.register("tid", spec).ok).toBe(true)
    // Registration alone does NOT run factory.
    expect(calls).toBe(0)
    const r1 = store.resolve("tid", "lazy")
    expect(r1.ok).toBe(true)
    expect(calls).toBe(1)
    const r2 = store.resolve("tid", "lazy")
    expect(r2.ok).toBe(true)
    expect(calls).toBe(1)
    // Same Tool reference returned both times (cache hit).
    if (!r1.ok || !r2.ok) throw new Error("unreachable")
    expect(r1.value).toBe(r2.value)
  })

  test("HELL-TT-07: cross-thread isolation", () => {
    const store = inMemoryThreadToolStore()
    expect(
      store.register(
        "A",
        mkSpec("only-on-A", false, () => mkTool("only-on-A")),
      ).ok,
    ).toBe(true)
    expect(store.list("A").length).toBe(1)
    expect(store.list("B").length).toBe(0)
    const rB = store.resolve("B", "only-on-A")
    expect(rB.ok).toBe(false)
    if (rB.ok) throw new Error("unreachable")
    expect(rB.error.code).toBe("not-found")
  })

  test("HELL-TT-08: evictNamespace drops only that namespace", () => {
    const store = inMemoryThreadToolStore()
    expect(
      store.register(
        "tid",
        mkSpec("a1", false, () => mkTool("a1"), "ns-A"),
      ).ok,
    ).toBe(true)
    expect(
      store.register(
        "tid",
        mkSpec("a2", false, () => mkTool("a2"), "ns-A"),
      ).ok,
    ).toBe(true)
    expect(
      store.register(
        "tid",
        mkSpec("b1", false, () => mkTool("b1"), "ns-B"),
      ).ok,
    ).toBe(true)
    expect(
      store.register(
        "tid",
        mkSpec("ungrouped", false, () => mkTool("ungrouped")),
      ).ok,
    ).toBe(true)
    expect(store.list("tid").length).toBe(4)
    store.evictNamespace("tid", "ns-A")
    const remaining = store
      .list("tid")
      .map((s) => s.name)
      .sort()
    expect(remaining).toEqual(["b1", "ungrouped"])
    // Resolve on an evicted spec → not-found.
    expect(store.resolve("tid", "a1").ok).toBe(false)
  })

  test("HELL-TT-09: evict(tid) drops every spec in that thread", () => {
    const store = inMemoryThreadToolStore()
    expect(
      store.register(
        "tid",
        mkSpec("x", false, () => mkTool("x")),
      ).ok,
    ).toBe(true)
    expect(
      store.register(
        "tid",
        mkSpec("y", false, () => mkTool("y")),
      ).ok,
    ).toBe(true)
    expect(store.list("tid").length).toBe(2)
    store.evict("tid")
    expect(store.list("tid")).toEqual([])
    expect(store.resolve("tid", "x").ok).toBe(false)
  })

  test("HELL-TT-10: composer — per-thread name wins over global name", () => {
    const globalA = mkTool("shared", "GLOBAL")
    const globalB = mkTool("globalOnly", "GLOBAL")
    const perThreadA = mkTool("shared", "PER-THREAD")
    const perThreadC = mkTool("threadOnly", "PER-THREAD")
    const merged = composeTools([globalA, globalB], [perThreadA, perThreadC])
    expect(merged.length).toBe(3)
    const byName = new Map(merged.map((t) => [t.name, t]))
    expect(byName.get("shared")).toBe(perThreadA)
    expect(byName.get("globalOnly")).toBe(globalB)
    expect(byName.get("threadOnly")).toBe(perThreadC)
  })

  test("HELL-TT-11: factory throws → Err('factory-failed', { cause })", () => {
    const store = inMemoryThreadToolStore()
    const boom = new Error("kaboom")
    // Eager path.
    const eagerSpec = mkSpec("boom-eager", false, () => {
      throw boom
    })
    const re = store.register("tid", eagerSpec)
    expect(re.ok).toBe(false)
    if (re.ok) throw new Error("unreachable")
    expect(re.error.code).toBe("factory-failed")
    if (re.error.code !== "factory-failed") throw new Error("unreachable")
    expect(re.error.cause).toBe(boom)
    // Eager-throw must NOT insert the spec.
    expect(store.list("tid")).toEqual([])

    // Deferred path.
    const lazySpec = mkSpec("boom-lazy", true, () => {
      throw boom
    })
    expect(store.register("tid", lazySpec).ok).toBe(true)
    const rr = store.resolve("tid", "boom-lazy")
    expect(rr.ok).toBe(false)
    if (rr.ok) throw new Error("unreachable")
    expect(rr.error.code).toBe("factory-failed")
    if (rr.error.code !== "factory-failed") throw new Error("unreachable")
    expect(rr.error.cause).toBe(boom)
  })

  test("HELL-TT-12: concurrent resolve x2 on deferred → factory exactly once", () => {
    // Factory is sync (() => Tool); 'concurrent' here means two back-to-back
    // calls with no awaits between them — single-flight is the Map-cache
    // check (no async window).
    const store = inMemoryThreadToolStore()
    let calls = 0
    const spec = mkSpec("once", true, () => {
      calls += 1
      return mkTool("once")
    })
    expect(store.register("tid", spec).ok).toBe(true)
    const [r1, r2] = [store.resolve("tid", "once"), store.resolve("tid", "once")]
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(calls).toBe(1)
    if (!r1.ok || !r2.ok) throw new Error("unreachable")
    expect(r1.value).toBe(r2.value)
  })

  test("HELL-TT-13: list default excludes deferred-not-yet-resolved entries", () => {
    const store = inMemoryThreadToolStore()
    expect(
      store.register(
        "tid",
        mkSpec("eager", false, () => mkTool("eager")),
      ).ok,
    ).toBe(true)
    expect(
      store.register(
        "tid",
        mkSpec("lazy", true, () => mkTool("lazy")),
      ).ok,
    ).toBe(true)
    // Default: includeDeferred=false ⇒ only the eager one.
    const def = store.list("tid")
    expect(def.length).toBe(1)
    expect(def[0]?.name).toBe("eager")
    // With includeDeferred=true ⇒ both.
    const all = store.list("tid", { includeDeferred: true })
    expect(all.length).toBe(2)
    expect(all.map((s) => s.name).sort()).toEqual(["eager", "lazy"])
    // After resolving the lazy one, default list includes it.
    expect(store.resolve("tid", "lazy").ok).toBe(true)
    const after = store.list("tid")
    expect(after.length).toBe(2)
  })

  test("HELL-TT-14: returned spec is frozen (mutation throws in strict mode)", () => {
    const store = inMemoryThreadToolStore()
    expect(
      store.register(
        "tid",
        mkSpec("frozen", false, () => mkTool("frozen")),
      ).ok,
    ).toBe(true)
    const [spec] = store.list("tid")
    expect(spec).toBeDefined()
    if (spec === undefined) throw new Error("unreachable")
    expect(Object.isFrozen(spec)).toBe(true)
    // Module-level code is strict by default — direct mutation throws.
    expect(() => {
      // @ts-expect-error — runtime assertion that mutation is rejected.
      spec.name = "mutated"
    }).toThrow()
  })

  test("HELL-TT-15: 1000 registrations → list returns all 1000", () => {
    const store = inMemoryThreadToolStore()
    const N = 1000
    for (let i = 0; i < N; i += 1) {
      const name = `tool-${i}`
      const r = store.register(
        "tid",
        mkSpec(name, false, () => mkTool(name)),
      )
      expect(r.ok).toBe(true)
    }
    const list = store.list("tid")
    expect(list.length).toBe(N)
    // Sanity: a uniformly-distributed sample resolves.
    expect(store.resolve("tid", "tool-0").ok).toBe(true)
    expect(store.resolve("tid", "tool-500").ok).toBe(true)
    expect(store.resolve("tid", "tool-999").ok).toBe(true)
  })
})

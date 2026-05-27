/**
 * ADR-0352 — Registry metrics decorator hellgate.
 */
import { describe, expect, test } from "bun:test"
import { createInMemorySessionResourceRegistry } from "@/agent/session-resource-registry"
import { withRegistryMetrics } from "../registry-metrics-decorator"
import type { MetricEmitterPort } from "../types"

interface Capture {
  counters: Array<{ name: string; delta: number; attrs?: Readonly<Record<string, string>> }>
  gauges: Array<{ name: string; value: number; attrs?: Readonly<Record<string, string>> }>
}

const mkCapture = (): { emitter: MetricEmitterPort; cap: Capture } => {
  const cap: Capture = { counters: [], gauges: [] }
  const emitter: MetricEmitterPort = {
    counter: (name, delta, attrs) => {
      const entry: Capture["counters"][number] =
        attrs === undefined ? { name, delta } : { name, delta, attrs }
      cap.counters.push(entry)
    },
    gauge: (name, value, attrs) => {
      const entry: Capture["gauges"][number] =
        attrs === undefined ? { name, value } : { name, value, attrs }
      cap.gauges.push(entry)
    },
  }
  return { emitter, cap }
}

const countsFor = (cap: Capture, name: string): number =>
  cap.counters.filter((c) => c.name === name).reduce((a, c) => a + c.delta, 0)

const lastGauge = (cap: Capture, name: string): number | null => {
  const gs = cap.gauges.filter((g) => g.name === name)
  return gs.length === 0 ? null : (gs[gs.length - 1]?.value ?? null)
}

describe("ADR-0352 — withRegistryMetrics", () => {
  test("A. getOrCreate first time ⇒ miss + size gauge=1", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    wrapped.getOrCreate("s1")
    expect(countsFor(cap, "codex_r2.registry.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.registry.hits")).toBe(0)
    expect(lastGauge(cap, "codex_r2.registry.size")).toBe(1)
  })

  test("B. getOrCreate same id second time ⇒ hit + same resources ref", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    const r1 = wrapped.getOrCreate("s1")
    const r2 = wrapped.getOrCreate("s1")
    expect(r2).toBe(r1)
    expect(countsFor(cap, "codex_r2.registry.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.registry.hits")).toBe(1)
  })

  test("C. evict ⇒ counter codex_r2.registry.evictions=1 + size gauge update", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    wrapped.getOrCreate("s1")
    wrapped.getOrCreate("s2")
    wrapped.evict("s1")
    expect(countsFor(cap, "codex_r2.registry.evictions")).toBe(1)
    expect(lastGauge(cap, "codex_r2.registry.size")).toBe(1)
  })

  test("D. evict non-existent ⇒ NO counter fires (registry was empty for that id)", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    wrapped.evict("nope")
    expect(countsFor(cap, "codex_r2.registry.evictions")).toBe(0)
  })

  test("E. clear() ⇒ counter delta == sizeBefore + size gauge=0", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    wrapped.getOrCreate("a")
    wrapped.getOrCreate("b")
    wrapped.getOrCreate("c")
    wrapped.clear()
    expect(countsFor(cap, "codex_r2.registry.evictions")).toBe(3)
    expect(lastGauge(cap, "codex_r2.registry.size")).toBe(0)
    // The clear emit carries reason="clear" attr
    const clearCtr = cap.counters.find(
      (c) => c.name === "codex_r2.registry.evictions" && c.attrs?.reason === "clear",
    )
    expect(clearCtr).toBeDefined()
  })

  test("F. peek hit/miss ⇒ split counters", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), { emitter })
    wrapped.peek("absent")
    wrapped.getOrCreate("present")
    wrapped.peek("present")
    expect(countsFor(cap, "codex_r2.registry.peek_misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.registry.peek_hits")).toBe(1)
  })

  test("G. emitter throws ⇒ swallowed, registry method still returns", () => {
    const throwingEmitter: MetricEmitterPort = {
      counter: () => {
        throw new Error("emitter boom")
      },
      gauge: () => {
        throw new Error("emitter boom")
      },
    }
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), {
      emitter: throwingEmitter,
    })
    const r = wrapped.getOrCreate("s1")
    expect(r).toBeDefined()
    expect(wrapped.getOrCreate("s1")).toBe(r)
  })

  test("H. prefix override ⇒ metric names re-rooted", () => {
    const { emitter, cap } = mkCapture()
    const wrapped = withRegistryMetrics(createInMemorySessionResourceRegistry(), {
      emitter,
      prefix: "alt",
    })
    wrapped.getOrCreate("s1")
    expect(countsFor(cap, "alt.registry.misses")).toBe(1)
    expect(countsFor(cap, "codex_r2.registry.misses")).toBe(0)
  })
})

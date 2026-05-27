/**
 * ADR-0358 — MetricsRegistry → MetricEmitterPort adapter hellgate.
 *
 * Pins:
 *   A. counter delegation — name, delta, attrs forwarded verbatim
 *   B. gauge delegation   — name, value, attrs forwarded verbatim
 *   C. undefined attrs    — forwarded as `undefined` (NOT empty object)
 *   D. registry throws    — propagates (adapter is pure delegation; the
 *      decorator layer wraps emit in safeEmit, not the adapter)
 *   E. delta = 0          — still calls registry (decorator decides skip)
 *   F. multi-emit         — sequential calls accumulate on the registry
 *   G. looksLikeMetricsRegistry — true for ADR-0144 shape
 *   H. looksLikeMetricsRegistry — false for legacy `Metrics` class shape
 *   I. looksLikeMetricsRegistry — false for null/undefined/primitives
 *   J. independent adapters — two registries wired separately do NOT alias
 */

import { describe, expect, test } from "bun:test"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"
import { adaptMetricsRegistryToEmitter, looksLikeMetricsRegistry } from "../metrics-adapter"

interface Captured {
  kind: "increment" | "gauge"
  name: string
  value: number
  labels?: Record<string, string>
}

const mkRegistry = (
  overrides: Partial<MetricsRegistry> = {},
): {
  reg: MetricsRegistry
  log: Captured[]
} => {
  const log: Captured[] = []
  const reg: MetricsRegistry = {
    increment(name, delta = 1, labels) {
      const entry: Captured =
        labels === undefined
          ? { kind: "increment", name, value: delta }
          : { kind: "increment", name, value: delta, labels }
      log.push(entry)
    },
    observe(_n, _v, _l) {
      // not used by adapter
    },
    gauge(name, value, labels) {
      const entry: Captured =
        labels === undefined
          ? { kind: "gauge", name, value }
          : { kind: "gauge", name, value, labels }
      log.push(entry)
    },
    snapshot(): ReadonlyArray<MetricSnapshot> {
      return []
    },
    reset() {
      log.length = 0
    },
    async flush() {
      return undefined
    },
    ...overrides,
  }
  return { reg, log }
}

describe("ADR-0358 — adaptMetricsRegistryToEmitter", () => {
  test("A. counter call ⇒ registry.increment with verbatim args", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.counter("codex_r2.cache.hits", 1, { reason: "warm" })
    expect(log).toHaveLength(1)
    const entry = log[0]
    if (entry === undefined) throw new Error("missing entry")
    expect(entry.kind).toBe("increment")
    expect(entry.name).toBe("codex_r2.cache.hits")
    expect(entry.value).toBe(1)
    expect(entry.labels).toEqual({ reason: "warm" })
  })

  test("B. gauge call ⇒ registry.gauge with verbatim args", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.gauge("codex_r2.cache.size", 42, { tier: "L1" })
    expect(log).toHaveLength(1)
    const entry = log[0]
    if (entry === undefined) throw new Error("missing entry")
    expect(entry.kind).toBe("gauge")
    expect(entry.name).toBe("codex_r2.cache.size")
    expect(entry.value).toBe(42)
    expect(entry.labels).toEqual({ tier: "L1" })
  })

  test("C. undefined attrs ⇒ forwarded as undefined (no empty-object substitution)", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.counter("codex_r2.activation.calls", 1)
    emitter.gauge("codex_r2.registry.size", 7)
    expect(log).toHaveLength(2)
    const a = log[0]
    const b = log[1]
    if (a === undefined || b === undefined) throw new Error("missing entry")
    expect(a.labels).toBeUndefined()
    expect(b.labels).toBeUndefined()
  })

  test("D. registry.increment throws ⇒ adapter propagates (decorator owns safeEmit)", () => {
    const reg: MetricsRegistry = {
      increment() {
        throw new Error("registry boom")
      },
      observe() {},
      gauge() {},
      snapshot() {
        return []
      },
      reset() {},
      async flush() {},
    }
    const emitter = adaptMetricsRegistryToEmitter(reg)
    expect(() => emitter.counter("x", 1)).toThrow("registry boom")
  })

  test("E. delta=0 ⇒ still delegates (registry sees 0, decorator decides skip)", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.counter("codex_r2.cache.invalidations", 0)
    expect(log).toHaveLength(1)
    const entry = log[0]
    if (entry === undefined) throw new Error("missing entry")
    expect(entry.value).toBe(0)
  })

  test("F. multiple sequential emits ⇒ all land on the registry in order", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.counter("a", 1)
    emitter.counter("a", 2)
    emitter.gauge("b", 5)
    emitter.counter("a", 3)
    expect(log.map((e) => `${e.kind}:${e.name}:${e.value}`)).toEqual([
      "increment:a:1",
      "increment:a:2",
      "gauge:b:5",
      "increment:a:3",
    ])
  })
})

describe("ADR-0358 — looksLikeMetricsRegistry duck-test", () => {
  test("G. ADR-0144 shape ⇒ true", () => {
    const { reg } = mkRegistry()
    expect(looksLikeMetricsRegistry(reg)).toBe(true)
  })

  test("H. legacy Metrics class shape ⇒ false (no increment/gauge methods)", () => {
    // The legacy `Metrics` class in src/observability/metrics.ts exposes
    // `counter(name).inc(delta)` — NOT a top-level `increment` method.
    // The duck test MUST reject this so wiring stays byte-identical when
    // a host passes the legacy recorder.
    const legacyLike = {
      counter: () => ({ inc: () => {} }),
      gauge: () => ({ set: () => {} }),
      timer: () => ({ start: () => () => 0, record: () => {}, stats: () => ({}) }),
      snapshot: () => ({ counters: {}, gauges: {}, timers: {} }),
    }
    expect(looksLikeMetricsRegistry(legacyLike)).toBe(false)
  })

  test("I. null / undefined / primitives ⇒ false (NO-THROW on garbage)", () => {
    expect(looksLikeMetricsRegistry(null)).toBe(false)
    expect(looksLikeMetricsRegistry(undefined)).toBe(false)
    expect(looksLikeMetricsRegistry(42)).toBe(false)
    expect(looksLikeMetricsRegistry("string")).toBe(false)
    expect(looksLikeMetricsRegistry(true)).toBe(false)
    expect(looksLikeMetricsRegistry({})).toBe(false)
    expect(looksLikeMetricsRegistry({ increment: 1, gauge: 2 })).toBe(false)
  })

  test("J. two adapters bound to different registries do NOT alias", () => {
    const a = mkRegistry()
    const b = mkRegistry()
    const eA = adaptMetricsRegistryToEmitter(a.reg)
    const eB = adaptMetricsRegistryToEmitter(b.reg)
    eA.counter("x", 1)
    eB.counter("y", 1)
    eB.counter("y", 1)
    expect(a.log).toHaveLength(1)
    expect(b.log).toHaveLength(2)
    const aFirst = a.log[0]
    const bFirst = b.log[0]
    if (aFirst === undefined || bFirst === undefined) throw new Error("missing entry")
    expect(aFirst.name).toBe("x")
    expect(bFirst.name).toBe("y")
  })
})

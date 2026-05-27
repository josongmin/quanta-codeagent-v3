/**
 * ADR-0358 / ADR-0366 — MetricsRegistry → MetricEmitterPort adapter hellgate.
 *
 * Pins:
 *   A. counter delegation — name, delta, attrs forwarded verbatim
 *   B. gauge delegation   — name, value, attrs forwarded verbatim
 *   C. undefined attrs    — forwarded as `undefined` (NOT empty object)
 *   D. registry.increment throws ⇒ adapter propagates (decorator owns safeEmit)
 *   E. delta = 0          — still calls registry (decorator decides skip)
 *   F. multi-emit         — sequential calls accumulate on the registry
 *   G. looksLikeMetricsRegistry — true for ADR-0144 shape
 *   H. looksLikeMetricsRegistry — false for legacy `Metrics` class shape
 *   I. looksLikeMetricsRegistry — false for null/undefined/primitives
 *   J. independent adapters — two registries wired separately do NOT alias
 *
 * ADR-0366 histogram pins:
 *   K. histogram present  — adapter MUST provide `histogram` method
 *   L. histogram delegation — name/value/attrs ⇒ registry.observe verbatim
 *   M. histogram undefined attrs ⇒ forwarded as undefined
 *   N. histogram throws ⇒ swallowed (adapter wraps observe in try/catch)
 *   O. histogram on plain emitter literal (no histogram method) ⇒ optional-call
 *      stays a no-op (backward compat for pre-0366 emitters)
 */

import { describe, expect, test } from "bun:test"
import {
  adaptMetricsRegistryToEmitter,
  looksLikeMetricsRegistry,
} from "@/observability/codex-r2-metrics/metrics-adapter"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"

interface Captured {
  kind: "increment" | "gauge" | "observe"
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
    observe(name, value, labels) {
      const entry: Captured =
        labels === undefined
          ? { kind: "observe", name, value }
          : { kind: "observe", name, value, labels }
      log.push(entry)
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

describe("ADR-0366 — histogram method on adapter", () => {
  test("K. adapter exposes histogram method", () => {
    const { reg } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    expect(typeof emitter.histogram).toBe("function")
  })

  test("L. histogram call ⇒ registry.observe with verbatim args", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    // Guard not strictly necessary here (adapter ALWAYS provides histogram)
    // but mirror the recommended optional-call shape.
    emitter.histogram?.("codex_r2.turn.duration_ms", 123, { mode: "agent" })
    expect(log).toHaveLength(1)
    const entry = log[0]
    if (entry === undefined) throw new Error("missing entry")
    expect(entry.kind).toBe("observe")
    expect(entry.name).toBe("codex_r2.turn.duration_ms")
    expect(entry.value).toBe(123)
    expect(entry.labels).toEqual({ mode: "agent" })
  })

  test("M. histogram undefined attrs ⇒ forwarded as undefined (NOT empty object)", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.histogram?.("codex_r2.lock.wait_ms", 5)
    expect(log).toHaveLength(1)
    const entry = log[0]
    if (entry === undefined) throw new Error("missing entry")
    expect(entry.kind).toBe("observe")
    expect(entry.labels).toBeUndefined()
  })

  test("N. registry.observe throws ⇒ adapter swallows (NO-THROW posture)", () => {
    const reg: MetricsRegistry = {
      increment() {},
      observe() {
        throw new Error("observe boom")
      },
      gauge() {},
      snapshot() {
        return []
      },
      reset() {},
      async flush() {},
    }
    const emitter = adaptMetricsRegistryToEmitter(reg)
    expect(() => emitter.histogram?.("x", 1)).not.toThrow()
    // Sanity: same emitter still works on the OTHER methods (no aliasing damage).
    expect(() => emitter.counter("y", 1)).not.toThrow()
    expect(() => emitter.gauge("z", 2)).not.toThrow()
  })

  test("O. pre-0366 emitter literal lacking histogram ⇒ optional-call no-op", () => {
    // Backward-compat: emitter authors who do not provide `histogram` must
    // remain valid `MetricEmitterPort` implementations, and callers using
    // the documented `emitter.histogram?.(...)` shape MUST NOT throw.
    const legacyEmitter = {
      counter() {},
      gauge() {},
    } as const // no histogram field
    // Caller pattern: optional-call against the port-typed reference.
    const port: import("@/observability/codex-r2-metrics/types").MetricEmitterPort = legacyEmitter
    expect(() => port.histogram?.("x", 1)).not.toThrow()
    expect(port.histogram).toBeUndefined()
  })

  test("P. histogram preserves multiple sequential observations in order", () => {
    const { reg, log } = mkRegistry()
    const emitter = adaptMetricsRegistryToEmitter(reg)
    emitter.histogram?.("t", 1)
    emitter.histogram?.("t", 2, { label: "a" })
    emitter.histogram?.("t", 3)
    expect(log.map((e) => `${e.kind}:${e.name}:${e.value}`)).toEqual([
      "observe:t:1",
      "observe:t:2",
      "observe:t:3",
    ])
    const second = log[1]
    if (second === undefined) throw new Error("missing entry")
    expect(second.labels).toEqual({ label: "a" })
  })
})

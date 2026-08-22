/**
 * OTel sink — hellgate (ADR-0150).
 *
 * Seals the closed-port adapter `MetricSample → OTel Counter/Histogram/
 * UpDownCounter` across 4 sections — 13 cases total. Uses a fake
 * `MeterProvider` (structural) so the test depends on zero OTel runtime.
 *
 * Sections:
 *   A. adapter contract (4)        — sink shape, lazy meter init, counter/histogram dispatch
 *   B. instrument caching (3)      — cache reuse, distinct names, kind lock
 *   C. gauge emulation (2)         — UpDownCounter creation + correct delta arithmetic
 *   D. no-throw + flush + labels (4) — instrument throw, flush throw, empty labels, populated labels
 */

import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/in-memory-registry"
import {
  type OtelAttributes,
  type OtelCounter,
  type OtelHistogram,
  type OtelMeter,
  type OtelMeterProvider,
  type OtelUpDownCounter,
  otelMetricsSink,
} from "@/observability/metrics/otel-sink"
import type { MetricSink } from "@/observability/metrics/port"

// ────────────────────────────────────────────────────────────────────────────
// Fake OTel surface
// ────────────────────────────────────────────────────────────────────────────

interface CounterCall {
  readonly value: number
  readonly attrs: OtelAttributes | undefined
}
interface HistogramCall {
  readonly value: number
  readonly attrs: OtelAttributes | undefined
}
interface UpDownCounterCall {
  readonly value: number
  readonly attrs: OtelAttributes | undefined
}

interface FakeCounter extends OtelCounter {
  readonly name: string
  readonly calls: CounterCall[]
  throwOnAdd: boolean
}
interface FakeHistogram extends OtelHistogram {
  readonly name: string
  readonly calls: HistogramCall[]
}
interface FakeUpDownCounter extends OtelUpDownCounter {
  readonly name: string
  readonly calls: UpDownCounterCall[]
}

interface FakeMeter extends OtelMeter {
  readonly counterFactoryCalls: string[]
  readonly histogramFactoryCalls: string[]
  readonly upDownFactoryCalls: string[]
  readonly counters: Map<string, FakeCounter>
  readonly histograms: Map<string, FakeHistogram>
  readonly upDowns: Map<string, FakeUpDownCounter>
}

interface FakeMeterProvider extends OtelMeterProvider {
  readonly getMeterCalls: Array<{ name: string; version: string | undefined }>
  forceFlushCount: number
  flushThrows: boolean
  readonly meters: Map<string, FakeMeter>
}

const makeMeter = (): FakeMeter => {
  const counters = new Map<string, FakeCounter>()
  const histograms = new Map<string, FakeHistogram>()
  const upDowns = new Map<string, FakeUpDownCounter>()
  const counterFactoryCalls: string[] = []
  const histogramFactoryCalls: string[] = []
  const upDownFactoryCalls: string[] = []
  return {
    counterFactoryCalls,
    histogramFactoryCalls,
    upDownFactoryCalls,
    counters,
    histograms,
    upDowns,
    createCounter(name) {
      counterFactoryCalls.push(name)
      const existing = counters.get(name)
      if (existing !== undefined) return existing
      const fake: FakeCounter = {
        name,
        calls: [],
        throwOnAdd: false,
        add(value, attrs) {
          if (this.throwOnAdd) throw new Error("boom")
          this.calls.push({ value, attrs })
        },
      }
      counters.set(name, fake)
      return fake
    },
    createHistogram(name) {
      histogramFactoryCalls.push(name)
      const existing = histograms.get(name)
      if (existing !== undefined) return existing
      const fake: FakeHistogram = {
        name,
        calls: [],
        record(value, attrs) {
          this.calls.push({ value, attrs })
        },
      }
      histograms.set(name, fake)
      return fake
    },
    createUpDownCounter(name) {
      upDownFactoryCalls.push(name)
      const existing = upDowns.get(name)
      if (existing !== undefined) return existing
      const fake: FakeUpDownCounter = {
        name,
        calls: [],
        add(value, attrs) {
          this.calls.push({ value, attrs })
        },
      }
      upDowns.set(name, fake)
      return fake
    },
  }
}

const makeProvider = (): FakeMeterProvider => {
  const meters = new Map<string, FakeMeter>()
  const getMeterCalls: Array<{ name: string; version: string | undefined }> = []
  const p: FakeMeterProvider = {
    getMeterCalls,
    forceFlushCount: 0,
    flushThrows: false,
    meters,
    getMeter(name, version) {
      getMeterCalls.push({ name, version })
      const existing = meters.get(name)
      if (existing !== undefined) return existing
      const m = makeMeter()
      meters.set(name, m)
      return m
    },
    async forceFlush() {
      if (p.flushThrows) throw new Error("flush-boom")
      p.forceFlushCount += 1
    },
  }
  return p
}

const at = 1_700_000_000_000

// ────────────────────────────────────────────────────────────────────────────
// A. ADAPTER CONTRACT (4)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-sink / A. adapter contract", () => {
  test("HELL-1: otelMetricsSink({meterProvider}) returns a MetricSink", () => {
    const provider = makeProvider()
    const sink: MetricSink = otelMetricsSink({ meterProvider: provider })
    expect(typeof sink.send).toBe("function")
    expect(typeof sink.flush).toBe("function")
  })

  test("HELL-2: meter created lazily on first send; getMeter called once across many sends", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider, meterName: "quanta-test" })
    expect(provider.getMeterCalls.length).toBe(0) // lazy
    sink.send({ name: "c1", kind: "counter", value: 1, at })
    sink.send({ name: "c2", kind: "counter", value: 2, at })
    sink.send({ name: "h1", kind: "histogram", value: 10, at })
    expect(provider.getMeterCalls.length).toBe(1)
    expect(provider.getMeterCalls[0]?.name).toBe("quanta-test")
  })

  test("HELL-3: counter sample → instrument.add(value, labels) called", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({
      name: "tool_calls_total",
      kind: "counter",
      value: 3,
      labels: { tool: "bash" },
      at,
    })
    const meter = provider.meters.get("quanta")
    const counter = meter?.counters.get("tool_calls_total")
    expect(counter?.calls.length).toBe(1)
    expect(counter?.calls[0]?.value).toBe(3)
    expect(counter?.calls[0]?.attrs).toEqual({ tool: "bash" })
  })

  test("HELL-4: histogram sample → instrument.record(value, labels) called", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({
      name: "turn_duration_ms",
      kind: "histogram",
      value: 123,
      labels: { phase: "verify" },
      at,
    })
    const meter = provider.meters.get("quanta")
    const hist = meter?.histograms.get("turn_duration_ms")
    expect(hist?.calls.length).toBe(1)
    expect(hist?.calls[0]?.value).toBe(123)
    expect(hist?.calls[0]?.attrs).toEqual({ phase: "verify" })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. INSTRUMENT CACHING (3)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-sink / B. instrument caching", () => {
  test("HELL-5: 2 samples same name → instrument created ONCE", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({ name: "c", kind: "counter", value: 1, at })
    sink.send({ name: "c", kind: "counter", value: 1, at })
    sink.send({ name: "c", kind: "counter", value: 1, at })
    const meter = provider.meters.get("quanta")
    expect(meter?.counterFactoryCalls.length).toBe(1)
    expect(meter?.counters.get("c")?.calls.length).toBe(3)
  })

  test("HELL-6: 2 samples different name → 2 instruments", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({ name: "a", kind: "counter", value: 1, at })
    sink.send({ name: "b", kind: "counter", value: 1, at })
    const meter = provider.meters.get("quanta")
    expect(meter?.counterFactoryCalls.length).toBe(2)
    expect(meter?.counters.size).toBe(2)
  })

  test("HELL-7: same name, different kind → injected warn (kind locked); second sample dropped", () => {
    // Slice purity (ADR-0144): no console.* default in @/observability.
    // Caller injects warn sink; absent ⇒ silent. Test injects + asserts call.
    const provider = makeProvider()
    const warns: string[] = []
    const sink = otelMetricsSink({
      meterProvider: provider,
      warn: (msg) => warns.push(msg),
    })
    sink.send({ name: "foo", kind: "counter", value: 1, at })
    // Wrong kind — must NOT throw; instrument must NOT be created.
    expect(() => sink.send({ name: "foo", kind: "histogram", value: 99, at })).not.toThrow()
    const meter = provider.meters.get("quanta")
    expect(meter?.counterFactoryCalls.length).toBe(1)
    expect(meter?.histogramFactoryCalls.length).toBe(0) // dropped
    expect(meter?.histograms.size).toBe(0)
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain("foo")
    expect(warns[0]).toContain("counter")
    expect(warns[0]).toContain("histogram")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. GAUGE EMULATION (2)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-sink / C. gauge emulation", () => {
  test("HELL-8: gauge sample → UpDownCounter instrument created and add() called with initial value", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({ name: "queue_depth", kind: "gauge", value: 5, at })
    const meter = provider.meters.get("quanta")
    expect(meter?.upDownFactoryCalls).toEqual(["queue_depth"])
    const ud = meter?.upDowns.get("queue_depth")
    // prev = 0, delta = 5
    expect(ud?.calls.length).toBe(1)
    expect(ud?.calls[0]?.value).toBe(5)
  })

  test("HELL-9: consecutive gauge updates → correct delta arithmetic (per labels-key)", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    // No labels — delta should accumulate to current value.
    sink.send({ name: "g", kind: "gauge", value: 10, at }) // delta=10 (0→10)
    sink.send({ name: "g", kind: "gauge", value: 7, at }) // delta=-3 (10→7)
    sink.send({ name: "g", kind: "gauge", value: 7, at }) // delta=0  (suppressed)
    sink.send({ name: "g", kind: "gauge", value: 12, at }) // delta=+5 (7→12)
    // Different labels — independent prev-value series.
    sink.send({ name: "g", kind: "gauge", value: 4, labels: { region: "us" }, at }) // delta=4 (0→4)
    sink.send({ name: "g", kind: "gauge", value: 9, labels: { region: "us" }, at }) // delta=5 (4→9)
    const meter = provider.meters.get("quanta")
    const ud = meter?.upDowns.get("g")
    expect(ud?.calls.length).toBe(5) // delta=0 was suppressed
    expect(ud?.calls.map((c) => c.value)).toEqual([10, -3, 5, 4, 5])
    // Sum at OTel collector = 10 - 3 + 5 = 12 for {} series, 4 + 5 = 9 for {region:us}.
    const noLabelSum = (ud?.calls ?? [])
      .filter((c) => c.attrs === undefined)
      .reduce((a, c) => a + c.value, 0)
    const usSum = (ud?.calls ?? [])
      .filter((c) => c.attrs !== undefined && (c.attrs as Record<string, string>).region === "us")
      .reduce((a, c) => a + c.value, 0)
    expect(noLabelSum).toBe(12)
    expect(usSum).toBe(9)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. NO-THROW + FLUSH + LABELS (4)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-sink / D. no-throw + flush + labels", () => {
  test("HELL-10: instrument.add throws → sink does NOT throw; sample dropped silently", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    // First send to create the instrument.
    sink.send({ name: "c", kind: "counter", value: 1, at })
    const meter = provider.meters.get("quanta")
    const counter = meter?.counters.get("c")
    expect(counter).toBeDefined()
    if (counter !== undefined) counter.throwOnAdd = true
    expect(() => sink.send({ name: "c", kind: "counter", value: 2, at })).not.toThrow()
    // The throwing add was attempted (call recorded BEFORE throw in our fake
    // would be wrong — our fake throws BEFORE pushing), so calls remains 1.
    expect(counter?.calls.length).toBe(1)
  })

  test("HELL-11: meterProvider.forceFlush throws → flush() resolves without throwing", async () => {
    const provider = makeProvider()
    provider.flushThrows = true
    const sink = otelMetricsSink({ meterProvider: provider })
    sink.send({ name: "c", kind: "counter", value: 1, at })
    await expect(sink.flush?.()).resolves.toBeUndefined()
    // And the happy-path flush is also wired:
    provider.flushThrows = false
    await sink.flush?.()
    expect(provider.forceFlushCount).toBe(1)
  })

  test("HELL-12: labels omitted → instrument called with NO attrs (undefined)", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider })
    // No labels key on the sample at all.
    sink.send({ name: "c", kind: "counter", value: 1, at })
    const meter = provider.meters.get("quanta")
    const counter = meter?.counters.get("c")
    expect(counter?.calls.length).toBe(1)
    expect(counter?.calls[0]?.attrs).toBeUndefined()
    // Empty labels object → also undefined (OTel "no attributes" semantics).
    sink.send({ name: "c", kind: "counter", value: 1, labels: {}, at })
    expect(counter?.calls[1]?.attrs).toBeUndefined()
  })

  test("HELL-13: end-to-end via defaultMetricsRegistry → samples land on OTel instruments", () => {
    const provider = makeProvider()
    const sink = otelMetricsSink({ meterProvider: provider, meterName: "e2e" })
    const r = defaultMetricsRegistry({ sink })
    r.increment("ops", 1, { kind: "read" })
    r.increment("ops", 1, { kind: "read" })
    r.observe("latency_ms", 250)
    r.gauge("inflight", 3)
    const meter = provider.meters.get("e2e")
    expect(meter?.counters.get("ops")?.calls.length).toBe(2)
    expect(meter?.histograms.get("latency_ms")?.calls.length).toBe(1)
    expect(meter?.upDowns.get("inflight")?.calls.length).toBe(1)
    expect(meter?.upDowns.get("inflight")?.calls[0]?.value).toBe(3)
  })
})

/**
 * Observability metrics — hellgate (ADR-0144).
 *
 * Closed-port DI primitive: counter / histogram / gauge typed registry with
 * an injected `MetricSink` adapter. Hellgate seals the 6 contract clauses
 * (pure store, name-commits-to-kind, sink no-throw, sanitization, percentile
 * algorithm, label normalization) across 5 sections — 22 cases total.
 *
 * Sections:
 *   A. registry core (8)
 *   B. sink integration (4)
 *   C. consoleSink + jsonlSink (4)
 *   D. histogram math (4)
 *   E. exhaustive edge cases (2)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  consoleMetricsSink,
  defaultMetricsRegistry,
  jsonlMetricsSink,
  type MetricSample,
  type MetricSink,
  MetricsError,
} from "@/observability/metrics/index"

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const sinkOf = (): { sink: MetricSink; samples: MetricSample[]; flushCount: number } => {
  const samples: MetricSample[] = []
  let flushCount = 0
  const sink: MetricSink = {
    send(s) {
      samples.push(s)
    },
    async flush() {
      flushCount += 1
    },
  }
  return {
    sink,
    samples,
    get flushCount() {
      return flushCount
    },
  } as { sink: MetricSink; samples: MetricSample[]; flushCount: number }
}

// ────────────────────────────────────────────────────────────────────────────
// A. REGISTRY CORE (8)
// ────────────────────────────────────────────────────────────────────────────
describe("metrics / A. registry core", () => {
  test("HELL-1: increment('foo') → snapshot has 1 entry with value 1", () => {
    const r = defaultMetricsRegistry()
    r.increment("foo")
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.name).toBe("foo")
    expect(snap[0]?.kind).toBe("counter")
    expect(snap[0]?.value).toBe(1)
  })

  test("HELL-2: increment('foo', 5) after increment('foo') → value 6", () => {
    const r = defaultMetricsRegistry()
    r.increment("foo")
    r.increment("foo", 5)
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.value).toBe(6)
  })

  test("HELL-3: same name, different labels → 2 entries", () => {
    const r = defaultMetricsRegistry()
    r.increment("tool_calls_total", 1, { tool: "bash" })
    r.increment("tool_calls_total", 1, { tool: "edit" })
    const snap = r.snapshot()
    expect(snap.length).toBe(2)
    const tools = snap.map((s) => s.labels.tool).sort()
    expect(tools).toEqual(["bash", "edit"])
  })

  test("HELL-4: observe('bar', 100) → histogram with count 1, p50≈100", () => {
    const r = defaultMetricsRegistry()
    r.observe("bar", 100)
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.kind).toBe("histogram")
    expect(snap[0]?.count).toBe(1)
    expect(snap[0]?.p50).toBe(100)
    expect(snap[0]?.value).toBe(100) // sum
  })

  test("HELL-5: observe 100 uniform samples [1..100] → correct percentiles", () => {
    const r = defaultMetricsRegistry()
    for (let i = 1; i <= 100; i += 1) r.observe("lat", i)
    const snap = r.snapshot()
    const row = snap[0]
    expect(row?.count).toBe(100)
    // nearest-rank: p50 = ceil(0.5*100)=50 → index 49 → value 50
    expect(row?.p50).toBe(50)
    expect(row?.p95).toBe(95)
    expect(row?.p99).toBe(99)
  })

  test("HELL-6: gauge('baz', 7) then gauge('baz', 3) → latest wins", () => {
    const r = defaultMetricsRegistry()
    r.gauge("baz", 7)
    r.gauge("baz", 3)
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.value).toBe(3)
    expect(snap[0]?.kind).toBe("gauge")
  })

  test("HELL-7: reset() → empty snapshot AND name kinds released", () => {
    const r = defaultMetricsRegistry()
    r.increment("foo")
    r.gauge("baz", 1)
    expect(r.snapshot().length).toBe(2)
    r.reset()
    expect(r.snapshot().length).toBe(0)
    // After reset, the kind commit map is also cleared — a name can be re-used.
    r.gauge("foo", 9)
    expect(() => r.gauge("foo", 10)).not.toThrow()
  })

  test("HELL-8: name kind clash → MetricsError('name-mismatch-kind')", () => {
    const r = defaultMetricsRegistry()
    r.gauge("foo", 5)
    let thrown: unknown
    try {
      r.increment("foo", 1)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MetricsError)
    expect((thrown as MetricsError).errorCode).toBe("name-mismatch-kind")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. SINK INTEGRATION (4)
// ────────────────────────────────────────────────────────────────────────────
describe("metrics / B. sink integration", () => {
  test("HELL-9: sink absent → no error; snapshot still populated", () => {
    const r = defaultMetricsRegistry()
    expect(() => {
      r.increment("foo")
      r.observe("bar", 10)
      r.gauge("baz", 3)
    }).not.toThrow()
    expect(r.snapshot().length).toBe(3)
  })

  test("HELL-10: sink wired → each record → 1 send call", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    r.increment("foo")
    r.observe("bar", 10)
    r.gauge("baz", 3)
    expect(samples.length).toBe(3)
    expect(samples[0]?.kind).toBe("counter")
    expect(samples[1]?.kind).toBe("histogram")
    expect(samples[2]?.kind).toBe("gauge")
  })

  test("HELL-11: sink.send throws → registry still records (no-throw)", () => {
    const throwingSink: MetricSink = {
      send() {
        throw new Error("boom")
      },
    }
    const r = defaultMetricsRegistry({ sink: throwingSink })
    expect(() => r.increment("foo", 5)).not.toThrow()
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.value).toBe(5)
  })

  test("HELL-12: flush() propagates to sink.flush()", async () => {
    let flushed = 0
    const sink: MetricSink = {
      send() {},
      async flush() {
        flushed += 1
      },
    }
    const r = defaultMetricsRegistry({ sink })
    r.increment("foo")
    await r.flush()
    expect(flushed).toBe(1)
    // And the registry's flush is also a no-op when sink lacks flush.
    const r2 = defaultMetricsRegistry({ sink: { send() {} } })
    await expect(r2.flush()).resolves.toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. consoleSink + jsonlSink (4)
// ────────────────────────────────────────────────────────────────────────────
describe("metrics / C. built-in sinks", () => {
  let stderrCalls: string[] = []
  let originalStderrWrite: typeof process.stderr.write
  let tmp: string

  beforeEach(() => {
    stderrCalls = []
    originalStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrCalls.push(typeof chunk === "string" ? chunk : String(chunk))
      return true
    }) as typeof process.stderr.write
    tmp = join(tmpdir(), `metrics-hellgate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  })

  afterEach(() => {
    process.stderr.write = originalStderrWrite
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test("HELL-13: consoleSink writes to stderr", () => {
    const r = defaultMetricsRegistry({ sink: consoleMetricsSink })
    r.increment("tool_calls_total", 1, { tool: "bash" })
    const joined = stderrCalls.join("")
    expect(joined).toContain("[metric]")
    expect(joined).toContain("name=tool_calls_total")
    expect(joined).toContain("kind=counter")
    expect(joined).toContain("val=1")
    expect(joined).toContain("tool:bash")
  })

  test("HELL-14: jsonlSink appends 1 line per send", () => {
    const path = join(tmp, "metrics.jsonl")
    const sink = jsonlMetricsSink(path)
    const r = defaultMetricsRegistry({ sink })
    r.increment("foo", 1)
    r.observe("bar", 42)
    r.gauge("baz", 7)
    const content = readFileSync(path, "utf-8")
    const lines = content.trimEnd().split("\n")
    expect(lines.length).toBe(3)
    const first = JSON.parse(lines[0] ?? "{}") as MetricSample
    expect(first.name).toBe("foo")
    expect(first.kind).toBe("counter")
    expect(first.value).toBe(1)
  })

  test("HELL-15: jsonlSink path missing dir → auto-creates parent dir", () => {
    const nested = join(tmp, "a", "b", "c", "metrics.jsonl")
    const sink = jsonlMetricsSink(nested)
    const r = defaultMetricsRegistry({ sink })
    expect(() => r.increment("foo")).not.toThrow()
    // File exists, parent dirs were created.
    const stat = statSync(nested)
    expect(stat.isFile()).toBe(true)
  })

  test("HELL-16: jsonlSink flush is a no-op (sync write) — resolves quickly", async () => {
    const path = join(tmp, "metrics.jsonl")
    // Ensure parent dir exists so the construction succeeds cleanly.
    mkdirSync(tmp, { recursive: true })
    const sink = jsonlMetricsSink(path)
    const r = defaultMetricsRegistry({ sink })
    r.increment("foo")
    // Should resolve essentially immediately (sync write).
    const start = Date.now()
    await r.flush()
    expect(Date.now() - start).toBeLessThan(100)
    // The file content is already on disk before flush (sync write).
    const content = readFileSync(path, "utf-8")
    expect(content.trim().length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. HISTOGRAM MATH (4)
// ────────────────────────────────────────────────────────────────────────────
describe("metrics / D. histogram math", () => {
  test("HELL-17: single observation → p50=p95=p99=value, count=1", () => {
    const r = defaultMetricsRegistry()
    r.observe("lat", 42)
    const row = r.snapshot()[0]
    expect(row?.count).toBe(1)
    expect(row?.p50).toBe(42)
    expect(row?.p95).toBe(42)
    expect(row?.p99).toBe(42)
    expect(row?.value).toBe(42) // sum
  })

  test("HELL-18: 100 uniform samples [1..100] → p50≈50 p95≈95 p99≈99", () => {
    const r = defaultMetricsRegistry()
    // Insert in non-sorted order to exercise the snapshot-time sort.
    const order = [...Array(100).keys()].map((i) => i + 1)
    order.sort(() => Math.random() - 0.5)
    for (const v of order) r.observe("lat", v)
    const row = r.snapshot()[0]
    expect(row?.count).toBe(100)
    expect(row?.p50).toBe(50)
    expect(row?.p95).toBe(95)
    expect(row?.p99).toBe(99)
  })

  test("HELL-19: label combinations create distinct buckets", () => {
    const r = defaultMetricsRegistry()
    r.observe("tool_latency_ms", 10, { tool: "bash" })
    r.observe("tool_latency_ms", 20, { tool: "bash" })
    r.observe("tool_latency_ms", 1000, { tool: "edit" })
    const snap = r.snapshot()
    expect(snap.length).toBe(2)
    const bash = snap.find((s) => s.labels.tool === "bash")
    const edit = snap.find((s) => s.labels.tool === "edit")
    expect(bash?.count).toBe(2)
    expect(bash?.value).toBe(30) // sum
    expect(edit?.count).toBe(1)
    expect(edit?.value).toBe(1000)
  })

  test("HELL-20: histogramBuckets injection accepted (shape validation)", () => {
    // Today buckets are reserved for future bucketed-exposition (contract #5).
    // The constructor must accept them without throwing and snapshots stay
    // correct using nearest-rank percentiles.
    const r = defaultMetricsRegistry({
      histogramBuckets: [5, 50, 500, 5000],
    })
    for (let i = 1; i <= 10; i += 1) r.observe("x", i)
    const row = r.snapshot()[0]
    expect(row?.count).toBe(10)
    // p50 of 1..10 = ceil(0.5*10)=5 → index 4 → value 5
    expect(row?.p50).toBe(5)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. EDGE CASES (2) — sanitization + label normalization
// ────────────────────────────────────────────────────────────────────────────
describe("metrics / E. edge cases", () => {
  test("HELL-21: negative / NaN delta coerced to 0 for counters and histograms", () => {
    const r = defaultMetricsRegistry()
    r.increment("c", -5) // coerced to 0
    r.increment("c", Number.NaN) // coerced to 0
    r.increment("c", 3)
    const counter = r.snapshot().find((s) => s.name === "c")
    expect(counter?.value).toBe(3)
    r.observe("h", -10) // coerced to 0
    r.observe("h", Number.POSITIVE_INFINITY) // non-finite → 0
    r.observe("h", 5)
    const hist = r.snapshot().find((s) => s.name === "h")
    expect(hist?.count).toBe(3)
    expect(hist?.value).toBe(5) // sum of 0+0+5
  })

  test("HELL-22: label order does not split a series (sorted-key normalize)", () => {
    const r = defaultMetricsRegistry()
    r.increment("x", 1, { a: "1", b: "2" })
    r.increment("x", 1, { b: "2", a: "1" })
    const snap = r.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.value).toBe(2)
  })
})

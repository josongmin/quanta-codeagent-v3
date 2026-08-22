/**
 * Bugbash fixes — in-memory metrics registry (jun-20).
 *
 * #13 (silent-failure): a throwing sink's send/flush drops are now COUNTED in
 *      `diagnostics()` instead of vanishing — export health is observable.
 * #12 (efficiency / cardinality leak): a per-metric-name series cap bounds the
 *      `series` map so an unbounded-cardinality label cannot leak it; overflow
 *      is dropped + counted rather than growing forever.
 *
 * Each test has TEETH: it fails if the fix is reverted (the counter would stay
 * 0 with the old swallow, and the series map would grow without bound).
 */

import { describe, expect, test } from "bun:test"
import {
  defaultMetricsRegistry,
  type MetricSample,
  type MetricSink,
} from "@/observability/metrics/index"

// A sink whose send/flush always throw — models a misconfigured exporter
// (down OTLP endpoint, network error) that violates the no-throw contract.
const throwingSink = (): MetricSink => ({
  send(_: MetricSample) {
    throw new Error("sink down")
  },
  async flush() {
    throw new Error("flush down")
  },
})

// ────────────────────────────────────────────────────────────────────────────
// #13 — silent sink failure becomes observable
// ────────────────────────────────────────────────────────────────────────────
describe("bugbash #13 / sink failure is counted, not swallowed", () => {
  test("throwing send increments diagnostics().exportDropped, not the snapshot", () => {
    const r = defaultMetricsRegistry({ sink: throwingSink() })

    expect(r.diagnostics().exportDropped).toBe(0)
    r.increment("foo")
    r.increment("foo")
    r.observe("lat", 5)

    // TEETH: with the old bare `catch {}` this stays 0. Three sends threw.
    expect(r.diagnostics().exportDropped).toBe(3)

    // In-memory accumulators are still updated (drop only affects EXPORT).
    const foo = r.snapshot().find((s) => s.name === "foo")
    expect(foo?.value).toBe(2)
  })

  test("a healthy sink never increments exportDropped", () => {
    const sent: MetricSample[] = []
    const r = defaultMetricsRegistry({
      sink: {
        send(s) {
          sent.push(s)
        },
      },
    })
    r.increment("ok")
    r.gauge("g", 7)

    expect(sent).toHaveLength(2)
    // TEETH (no false-positive): a working sink must read 0 dropped.
    expect(r.diagnostics().exportDropped).toBe(0)
  })

  test("throwing flush increments diagnostics().flushDropped", async () => {
    const r = defaultMetricsRegistry({ sink: throwingSink() })

    expect(r.diagnostics().flushDropped).toBe(0)
    await r.flush()

    // TEETH: old flush `catch {}` left this invisible (0). flush() must not throw.
    expect(r.diagnostics().flushDropped).toBe(1)
  })

  test("diagnostics() is a frozen snapshot — callers cannot mutate registry state", () => {
    const r = defaultMetricsRegistry({ sink: throwingSink() })
    r.increment("a")
    const d = r.diagnostics()
    expect(Object.isFrozen(d)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// #12 — per-metric-name series cardinality cap bounds the series map
// ────────────────────────────────────────────────────────────────────────────
describe("bugbash #12 / series cardinality is bounded + counted", () => {
  test("exceeding maxSeriesPerName drops new series; snapshot size is capped", () => {
    const cap = 4
    const r = defaultMetricsRegistry({ maxSeriesPerName: cap })

    // 10 distinct high-cardinality labels under ONE metric name.
    for (let i = 0; i < 10; i += 1) {
      r.increment("req.total", 1, { reqId: `id-${i}` })
    }

    // TEETH: without the cap the snapshot would have 10 rows (unbounded leak).
    const rows = r.snapshot().filter((s) => s.name === "req.total")
    expect(rows).toHaveLength(cap)
    expect(r.diagnostics().seriesDropped).toBe(10 - cap)
  })

  test("existing series keep updating after the cap is hit (only NEW series drop)", () => {
    const r = defaultMetricsRegistry({ maxSeriesPerName: 2 })

    r.increment("c", 1, { a: "1" })
    r.increment("c", 1, { a: "2" })
    // Cap reached — this new label is dropped...
    r.increment("c", 1, { a: "3" })
    // ...but re-incrementing an ADMITTED series still works.
    r.increment("c", 5, { a: "1" })

    const admitted = r.snapshot().find((s) => s.name === "c" && s.labels.a === "1")
    expect(admitted?.value).toBe(6)
    const dropped = r.snapshot().find((s) => s.name === "c" && s.labels.a === "3")
    expect(dropped).toBeUndefined()
    expect(r.diagnostics().seriesDropped).toBe(1)
  })

  test("the cap is PER name — separate metric names get independent budgets", () => {
    const r = defaultMetricsRegistry({ maxSeriesPerName: 2 })

    r.increment("x", 1, { a: "1" })
    r.increment("x", 1, { a: "2" })
    r.increment("x", 1, { a: "3" }) // dropped (x at cap)
    r.gauge("y", 1, { a: "1" })
    r.gauge("y", 2, { a: "2" }) // y still has headroom

    expect(r.snapshot().filter((s) => s.name === "x")).toHaveLength(2)
    expect(r.snapshot().filter((s) => s.name === "y")).toHaveLength(2)
    expect(r.diagnostics().seriesDropped).toBe(1)
  })

  test("reset() clears the per-name series budget so capacity is reclaimed", () => {
    const r = defaultMetricsRegistry({ maxSeriesPerName: 1 })

    r.increment("m", 1, { a: "1" })
    r.increment("m", 1, { a: "2" }) // dropped
    expect(r.diagnostics().seriesDropped).toBe(1)

    r.reset()
    // TEETH: if reset() forgot the count map, this admit would still be blocked.
    r.increment("m", 1, { a: "3" })
    expect(r.snapshot().filter((s) => s.name === "m")).toHaveLength(1)
  })

  test("default cap is generous — bounded-label paths are byte-identical (inert guard)", () => {
    const r = defaultMetricsRegistry()
    // Mirror the wired instrument-tool path: bounded {tool, ok} labels.
    for (const tool of ["read", "write", "bash"]) {
      for (const ok of ["true", "false"]) {
        r.increment("tool.calls.total", 1, { tool, ok })
      }
    }
    expect(r.snapshot()).toHaveLength(6)
    // Default path never trips the guard → no behavior change.
    expect(r.diagnostics().seriesDropped).toBe(0)
  })
})

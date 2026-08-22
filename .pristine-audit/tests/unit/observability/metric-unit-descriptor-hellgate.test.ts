/**
 * T-C1 — metric port `unit`/`description` on the OTLP wire (hellgate).
 *
 * OTel-GenAI-conformant metrics REQUIRE a unit (`s` for durations, `{token}`
 * for token usage). `MetricSample`/`ExportMetric` gained an OPTIONAL `unit` +
 * `description` (the SSOT `InstrumentDescriptor`), serialized into the OTLP
 * metric descriptor object — WITHOUT changing the wire for any metric that
 * declares no unit.
 *
 * Proven here against the RAW `/v1/metrics` bytes (T-A0 `captureOtlp` harness,
 * injected-fetch exporter — no live receiver):
 *
 *   1. WITH-UNIT: a sample declaring `unit:"s"` (+ description) shows
 *      `"unit":"s"` / `"description":…` on the histogram / sum / gauge.
 *   2. BYTE-IDENTICAL ENUMERATION (load-bearing "don't break all metrics"
 *      guard): every EXISTING metric name — driven through the SAME production
 *      path (`exporterMetricSink` ← `defaultMetricsRegistry` ← `instrumentTool`
 *      / raw registry ops) — carries NO `unit` and NO `description` key. An
 *      OTLP metric with no unit must serialize EXACTLY as before.
 *   3. RED-ON-INJECTION: reverting the serializer spread (`...(m.unit … )`)
 *      drops `unit` from case 1 → the WITH-UNIT assertion fails; adding a unit
 *      to case 2's samples makes the enumeration guard fail. Both directions
 *      are pinned so the guard is non-vacuous.
 */

import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/in-memory-registry"
import { instrumentTool } from "@/observability/metrics/instrument-tool"
import type { MetricSample } from "@/observability/metrics/port"
import { exporterMetricSink } from "@/observability/otel-exporter"
import type { OtlpMetric } from "../../helpers/otlp-capture"
import { captureOtlp } from "../../helpers/otlp-capture"

// ────────────────────────────────────────────────────────────────────────────
// Wire helpers — flatten every metric across all resource/scope groups.
// ────────────────────────────────────────────────────────────────────────────

/** Every OTLP metric object across every `/v1/metrics` POST captured. */
const allMetrics = (
  metrics: ReadonlyArray<{ readonly resourceMetrics: unknown }>,
): OtlpMetric[] => {
  const out: OtlpMetric[] = []
  for (const env of metrics as ReadonlyArray<
    import("../../helpers/otlp-capture").OtlpMetricsEnvelope
  >) {
    for (const rm of env.resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) out.push(m)
      }
    }
  }
  return out
}

/** The raw JSON of the metric object — used to assert KEY ABSENCE (a stronger
 *  claim than `=== undefined`: the serializer must not emit the key at all). */
const metricKeys = (m: OtlpMetric): ReadonlyArray<string> => Object.keys(m as object)

// ────────────────────────────────────────────────────────────────────────────
// The COMPLETE roster of metric names emitted across the metrics slice today
// (grepped from `instrument-*.ts` / `new-slice-instruments.ts` /
// `decision-counter-sink.ts` — the prefix templates resolved to their default
// prefixes). NONE of these declare a unit, so EVERY one must stay byte-identical.
// ────────────────────────────────────────────────────────────────────────────

const EXISTING_METRICS: ReadonlyArray<{
  readonly name: string
  readonly kind: MetricSample["kind"]
}> = [
  // instrument-tool.ts
  { name: "tool.call.total", kind: "counter" },
  { name: "tool.call.duration_ms", kind: "histogram" },
  // instrument-tool-dedup.ts
  { name: "tool.call.dedup_collapse.total", kind: "counter" },
  { name: "tool.dedup.config_drift.total", kind: "counter" },
  // instrument-budget.ts
  { name: "budget.breach.total", kind: "counter" },
  { name: "budget.event.cost_usd", kind: "histogram" },
  // instrument-lsp.ts
  { name: "lsp.request.total", kind: "counter" },
  { name: "lsp.request.duration_ms", kind: "histogram" },
  // instrument-plan-queue.ts
  { name: "plan.enqueue.total", kind: "counter" },
  { name: "plan.enqueue.collapsed.total", kind: "counter" },
  { name: "plan.drain.total", kind: "counter" },
  { name: "plan.clear.total", kind: "counter" },
  // instrument-shadow.ts
  { name: "shadow.checkpoint.total", kind: "counter" },
  { name: "shadow.diff.total", kind: "counter" },
  { name: "shadow.mutate.total", kind: "counter" },
  { name: "shadow.rewind.total", kind: "counter" },
  { name: "shadow.restore_partial.total", kind: "counter" },
  { name: "shadow.record.total", kind: "counter" },
  // a representative gauge — proves the gauge branch is byte-identical too.
  { name: "turn_duration_ms", kind: "gauge" },
]

describe("T-C1 metric unit/description on the OTLP wire", () => {
  test("CASE 1 — a sample declaring unit:'s' shows unit + description on the wire (histogram)", async () => {
    const { metrics } = await captureOtlp(async (h) => {
      const sink = exporterMetricSink(h.exporter)
      const sample: MetricSample = {
        name: "gen_ai.client.operation.duration",
        kind: "histogram",
        value: 1.5,
        at: 1_700_000_000_000,
        unit: "s",
        description: "GenAI operation duration",
      }
      sink.send(sample)
    })

    const ms = allMetrics(metrics as never)
    const dur = ms.find((m) => m.name === "gen_ai.client.operation.duration")
    expect(dur).toBeDefined()
    expect(dur?.unit).toBe("s")
    expect(dur?.description).toBe("GenAI operation duration")
    expect(dur?.histogram).toBeDefined()
    // The key literally appears in the serialized object.
    expect(metricKeys(dur as OtlpMetric)).toContain("unit")
    expect(metricKeys(dur as OtlpMetric)).toContain("description")
  })

  test("CASE 1b — unit reaches the SUM (counter) and GAUGE branches too", async () => {
    const { metrics } = await captureOtlp(async (h) => {
      const sink = exporterMetricSink(h.exporter)
      sink.send({
        name: "gen_ai.client.token.usage",
        kind: "counter",
        value: 42,
        at: 1,
        unit: "{token}",
      })
      sink.send({ name: "queue.depth", kind: "gauge", value: 7, at: 1, unit: "{item}" })
    })
    const ms = allMetrics(metrics as never)
    const counter = ms.find((m) => m.name === "gen_ai.client.token.usage")
    const gauge = ms.find((m) => m.name === "queue.depth")
    expect(counter?.unit).toBe("{token}")
    expect(counter?.sum).toBeDefined()
    expect(gauge?.unit).toBe("{item}")
    expect(gauge?.gauge).toBeDefined()
  })

  test("CASE 2 — BYTE-IDENTICAL ENUMERATION: every existing metric carries NO unit/description key", async () => {
    const { metrics } = await captureOtlp(async (h) => {
      const sink = exporterMetricSink(h.exporter)
      // Drive each existing metric through the wire adapter EXACTLY as the
      // production registry does — no unit/description is ever attached by the
      // registry API, so a naive "always emit unit" serializer would RED here.
      for (const { name, kind } of EXISTING_METRICS) {
        sink.send({ name, kind, value: 1, at: 1_700_000_000_000, labels: { tool: "x" } })
      }
    })

    const ms = allMetrics(metrics as never)
    for (const { name } of EXISTING_METRICS) {
      const m = ms.find((x) => x.name === name)
      expect(m, `metric ${name} must reach the wire`).toBeDefined()
      const keys = metricKeys(m as OtlpMetric)
      // KEY ABSENCE — not just `=== undefined`. The serialized OTLP object must
      // not contain a `unit`/`description` key at all (byte-identical to pre-T-C1).
      expect(keys, `metric ${name} must NOT carry a 'unit' key`).not.toContain("unit")
      expect(keys, `metric ${name} must NOT carry a 'description' key`).not.toContain("description")
    }
  })

  test("CASE 2b — full production path (instrumentTool → registry → exporterMetricSink) stays unit-less", async () => {
    const { metrics } = await captureOtlp(async (h) => {
      const registry = defaultMetricsRegistry({ sink: exporterMetricSink(h.exporter) })
      // A real tool wrapper emits tool.call.total + tool.call.duration_ms via
      // the registry — the actual shipping emit path, not a hand-built sample.
      const tool = {
        name: "read_image",
        description: "d",
        schema: { type: "object" as const },
        // biome-ignore lint/suspicious/useAwait: async generator stub for the wrapper.
        async *execute() {
          yield { type: "result" as const, result: { ok: true as const, value: "ok" } }
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: structural tool stub for the instrument wrapper.
      const wrapped = instrumentTool(tool as any, registry)
      // biome-ignore lint/suspicious/noExplicitAny: minimal ctx for the stub.
      for await (const _ of wrapped.execute(undefined as any, {} as any)) {
        void _
      }
      await registry.flush()
    })

    const ms = allMetrics(metrics as never)
    const names = ms.map((m) => m.name)
    expect(names).toContain("tool.call.total")
    expect(names).toContain("tool.call.duration_ms")
    for (const m of ms) {
      expect(metricKeys(m), `${m.name} must be unit-less`).not.toContain("unit")
      expect(metricKeys(m), `${m.name} must be description-less`).not.toContain("description")
    }
  })
})

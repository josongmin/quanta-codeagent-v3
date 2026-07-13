/**
 * T-C2 — GenAI client metrics at the sampling-span close (hellgate).
 *
 * `closeSamplingSpan` (loop-helpers.ts) emits the two OTel-GenAI Recommended
 * Histograms to the process-default METRIC sink (a plane distinct from the span
 * sink) whenever that sink is LIVE:
 *
 *   gen_ai.client.operation.duration   Histogram  unit `s`
 *   gen_ai.client.token.usage          Histogram  unit `{token}`  ×2 (input|output)
 *
 * Proven against the RAW `/v1/metrics` bytes (T-A0 `captureOtlp`, injected-fetch
 * exporter — no live receiver). Both names, both units, the input/output
 * `gen_ai.token.type` split, and the required dims are asserted on the wire.
 *
 * Adversarial / red-on-injection:
 *   · OFF byte-identical — no metric sink installed ⇒ ZERO metrics on the wire,
 *     even for a fully-populated close (usage + error).
 *   · token.type split — dropping either observation makes the "exactly two,
 *     one input + one output" assertion RED.
 *   · unit conformance — a bare number without `unit` fails the unit assertions.
 *   · error.type dim — present on an errored duration point, ABSENT on ok.
 *   · no collision with `{tool,ok}` metrics — names + label schema are disjoint.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { closeSamplingSpan, type SamplingUsage } from "@/agent/loop-helpers"
import {
  attrs,
  ERROR_ATTRS,
  GEN_AI_ATTRS,
  SPAN_NAMES,
  type SpanStatus,
  startSpan,
  type TurnTiming,
} from "@/observability"
import {
  __resetDefaultMetricSink,
  setDefaultMetricSink,
} from "@/observability/metrics/in-memory-registry"
import { exporterMetricSink } from "@/observability/otel-exporter"
import type { OtlpDataPoint, OtlpMetric, OtlpMetricsEnvelope } from "../../helpers/otlp-capture"
import { captureOtlp } from "../../helpers/otlp-capture"

const TIMING: TurnTiming = {
  requestSentAt: 0,
  firstTokenAt: 5,
  firstTokenLatencyMs: 5,
  streamEndAt: 2500,
  totalDurationMs: 2500, // → 2.5 s
  ttftMs: 5,
  totalTtftMs: 10,
}

const USAGE: SamplingUsage = { model: "gpt-5", inputTokens: 111, outputTokens: 222 }

/** All metric objects across every captured `/v1/metrics` POST. */
const allMetrics = (metrics: ReadonlyArray<OtlpMetricsEnvelope>): OtlpMetric[] =>
  metrics.flatMap((env) =>
    env.resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics)),
  )

const dimOf = (dp: OtlpDataPoint | undefined, key: string): string | undefined =>
  dp?.attributes.find((a) => a.key === key)?.value.stringValue

/** Drive one full sampling-span close with the metric sink installed. */
const closeWithMetrics = async (opts: {
  readonly status: SpanStatus
  readonly usage?: SamplingUsage
  readonly errorKind?: string
}) =>
  captureOtlp(async (h) => {
    setDefaultMetricSink(exporterMetricSink(h.exporter))
    const span = startSpan(
      SPAN_NAMES.runSamplingRequest,
      attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
      "client",
    )
    closeSamplingSpan(
      span,
      opts.status,
      TIMING,
      opts.usage,
      undefined,
      [],
      undefined,
      "gpt-5",
      "openai",
      opts.errorKind,
      undefined,
    )
  })

afterEach(() => {
  __resetDefaultMetricSink()
})

describe("T-C2 gen_ai.client.operation.duration", () => {
  test("present, unit `s`, value in SECONDS (ms→s), with required dims", async () => {
    const { metrics } = await closeWithMetrics({ status: "ok", usage: USAGE })
    const dur = allMetrics(metrics).find((m) => m.name === "gen_ai.client.operation.duration")
    expect(dur).toBeDefined()
    expect(dur?.unit).toBe("s")
    expect(dur?.histogram).toBeDefined()
    const dp = dur?.histogram?.dataPoints[0]
    // 2500 ms → 2.5 s (NOT the raw ms value — unit conformance).
    expect(dp?.sum).toBeCloseTo(2.5, 5)
    expect(dimOf(dp, GEN_AI_ATTRS.operation.name)).toBe("chat")
    expect(dimOf(dp, GEN_AI_ATTRS.provider.name)).toBe("openai")
    expect(dimOf(dp, GEN_AI_ATTRS.request.model)).toBe("gpt-5")
  })

  test("error.type dim present on an errored close, ABSENT on ok", async () => {
    const err = await closeWithMetrics({ status: "error", errorKind: "rate_limit" })
    const errDur = allMetrics(err.metrics).find(
      (m) => m.name === "gen_ai.client.operation.duration",
    )
    expect(dimOf(errDur?.histogram?.dataPoints[0], ERROR_ATTRS.type)).toBe("rate_limit")

    const ok = await closeWithMetrics({ status: "ok", usage: USAGE })
    const okDur = allMetrics(ok.metrics).find((m) => m.name === "gen_ai.client.operation.duration")
    expect(dimOf(okDur?.histogram?.dataPoints[0], ERROR_ATTRS.type)).toBeUndefined()
  })
})

describe("T-C2 gen_ai.client.token.usage", () => {
  test("unit `{token}`, TWO observations split by gen_ai.token.type input|output", async () => {
    const { metrics } = await closeWithMetrics({ status: "ok", usage: USAGE })
    // The serializer emits ONE metric object per recordMetric call (no
    // aggregation), so the two token observations arrive as two objects sharing
    // the name — collect ALL of them and flatten their datapoints.
    const toks = allMetrics(metrics).filter((m) => m.name === "gen_ai.client.token.usage")
    expect(toks.length).toBeGreaterThan(0)
    for (const t of toks) expect(t.unit).toBe("{token}")
    const dps = toks.flatMap((t) => t.histogram?.dataPoints ?? [])
    // Exactly two observations — one input, one output. Dropping either makes
    // this RED (red-on-injection on the split).
    const byType = new Map(dps.map((dp) => [dimOf(dp, "gen_ai.token.type"), dp]))
    expect(byType.size).toBe(2)
    expect(byType.has("input")).toBe(true)
    expect(byType.has("output")).toBe(true)
    expect(byType.get("input")?.sum).toBeCloseTo(111, 5)
    expect(byType.get("output")?.sum).toBeCloseTo(222, 5)
    // Required dims on each token point.
    for (const dp of dps) {
      expect(dimOf(dp, GEN_AI_ATTRS.operation.name)).toBe("chat")
      expect(dimOf(dp, GEN_AI_ATTRS.provider.name)).toBe("openai")
      expect(dimOf(dp, GEN_AI_ATTRS.request.model)).toBe("gpt-5")
    }
  })

  test("no usage ⇒ token.usage metric is skipped entirely (no bogus zeros)", async () => {
    const { metrics } = await closeWithMetrics({ status: "ok" })
    const tok = allMetrics(metrics).find((m) => m.name === "gen_ai.client.token.usage")
    expect(tok).toBeUndefined()
  })
})

describe("T-C2 OFF byte-identical + no collision", () => {
  test("no metric sink installed ⇒ ZERO metrics on the wire (byte-identical off)", async () => {
    const { metrics } = await captureOtlp(async () => {
      // Deliberately do NOT install a metric sink. The span sink from the
      // harness is a DIFFERENT plane; GenAI metrics must not ride it.
      const span = startSpan(
        SPAN_NAMES.runSamplingRequest,
        attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
        "client",
      )
      closeSamplingSpan(
        span,
        "error",
        TIMING,
        USAGE,
        undefined,
        [],
        undefined,
        "gpt-5",
        "openai",
        "network",
        undefined,
      )
    })
    expect(allMetrics(metrics).length).toBe(0)
  })

  test("metric NAMES are disjoint from the {tool,ok} tool metrics", async () => {
    const { metrics } = await closeWithMetrics({ status: "ok", usage: USAGE })
    const names = allMetrics(metrics).map((m) => m.name)
    expect(names).toContain("gen_ai.client.operation.duration")
    expect(names).toContain("gen_ai.client.token.usage")
    expect(names).not.toContain("tool.call.total")
    expect(names).not.toContain("tool.call.duration_ms")
  })
})

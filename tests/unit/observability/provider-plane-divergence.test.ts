/**
 * ADVERSARIAL probe — span/metric provider-plane AGREEMENT under a
 * provider-present / model-ABSENT close.
 *
 * `normalizeProviderName` is shared, but the two CALL SITES gate differently:
 *   - span (`buildSamplingSpanAttrs`): stamps `gen_ai.provider.name` ONLY inside
 *     `if (requestModel !== "")` — so a model-less close OMITS provider on the span.
 *   - metric (`resolveProviderSlug` → `buildGenAiMetricInput`): resolves the
 *     provider from `provider` FIRST (independent of model) — so the metric dim
 *     IS present.
 * Both `model` and `provider` are OPTIONAL on the LLM port (`ports.ts`), so a
 * provider-known / model-unknown adapter is reachable in prod. The header of
 * `buildSamplingSpanAttrs` claims span+metric "always agree" — this asserts it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { closeSamplingSpan } from "@/agent/loop-helpers"
import { attrs, GEN_AI_ATTRS, SPAN_NAMES, startSpan, type TurnTiming } from "@/observability"
import {
  __resetDefaultMetricSink,
  setDefaultMetricSink,
} from "@/observability/metrics/in-memory-registry"
import { exporterMetricSink } from "@/observability/otel-exporter"
import type { OtlpKeyValue } from "../../helpers/otlp-capture"
import { captureOtlp } from "../../helpers/otlp-capture"

const TIMING: TurnTiming = {
  requestSentAt: 0,
  firstTokenAt: 5,
  firstTokenLatencyMs: 5,
  streamEndAt: 2500,
  totalDurationMs: 2500,
  ttftMs: 5,
  totalTtftMs: 10,
}

const attrString = (kvs: ReadonlyArray<OtlpKeyValue>, key: string): string | undefined =>
  kvs.find((a) => a.key === key)?.value.stringValue

afterEach(() => {
  __resetDefaultMetricSink()
})

describe("provider-plane divergence (model absent, provider present)", () => {
  test("span and metric AGREE on gen_ai.provider.name presence", async () => {
    const { traces, metrics } = await captureOtlp(async (h) => {
      setDefaultMetricSink(exporterMetricSink(h.exporter))
      const span = startSpan(
        SPAN_NAMES.runSamplingRequest,
        attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
        "client",
      )
      // requestModel = undefined, provider = "anthropic".
      closeSamplingSpan(
        span,
        "ok",
        TIMING,
        { model: "claude-x", inputTokens: 10, outputTokens: 20 },
        undefined,
        [],
        undefined,
        undefined, // ← requestModel ABSENT
        "anthropic", // ← provider PRESENT
        undefined,
        undefined,
      )
    })

    const span = traces
      .flatMap((t) => t.resourceSpans)
      .flatMap((rs) => rs.scopeSpans)
      .flatMap((ss) => ss.spans)
      .find((s) => s.name.startsWith("chat"))
    const spanProvider = attrString(span?.attributes ?? [], GEN_AI_ATTRS.provider.name)

    const dp = metrics
      .flatMap((m) => m.resourceMetrics)
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.name === "gen_ai.client.operation.duration")?.histogram?.dataPoints[0]
    const metricProvider = attrString(dp?.attributes ?? [], GEN_AI_ATTRS.provider.name)

    // The two planes MUST agree — either both carry the normalized provider or
    // neither does. Today the span omits it (model-gated) while the metric emits
    // it → a split time-series the span can't be joined against.
    expect(spanProvider).toBe(metricProvider)
  })
})

/**
 * T-A0 — raw-OTLP proof harness (smoke).
 *
 * Conformance claims for the OTel-GenAI wire (span names, kinds, attribute keys,
 * value-types, metric units) must be backed by the RAW bytes a collector would
 * receive at `/v1/traces` + `/v1/metrics` — not by "the tests pass". This smoke
 * proves the harness (`captureOtlp`) drives a span/metric through the REAL
 * `otelHttpExporter` over an injected fake `fetch`, captures the POST bodies,
 * and hands back the parsed OTLP JSON so downstream tickets (A2/C2/D1/B5) can
 * assert on the wire.
 *
 * The single load-bearing assertion here: a `chat` (CLIENT) span's
 * `gen_ai.operation.name` attribute AND its OTLP span kind (CLIENT ⇒ enum 3)
 * reach the parsed `traces` payload — i.e. the capture is of the actual
 * serialized bytes, not an in-memory `ExportSpan` shortcut.
 */

import { describe, expect, test } from "bun:test"
import { attrs, endSpan, GEN_AI_ATTRS, SPAN_NAMES, startSpan } from "@/observability"
import { captureOtlp } from "../helpers/otlp-capture"

describe("T-A0 raw-OTLP capture harness", () => {
  test("captureOtlp returns parsed {traces, metrics} from the /v1/{traces,metrics} POST bodies", async () => {
    const { traces, metrics } = await captureOtlp(async (h) => {
      // Drive one `chat` CLIENT span through the injected-fetch exporter, via
      // the installed span sink (startSpan/endSpan route through it).
      const span = startSpan(
        SPAN_NAMES.runSamplingRequest,
        attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
        "client",
      )
      endSpan(span, "ok", attrs({ [GEN_AI_ATTRS.response.model]: "claude-test-4" }))
      // Also record a metric so the /v1/metrics leg is exercised end-to-end.
      h.exporter.recordMetric({
        name: "gen_ai.client.token.usage",
        kind: "histogram",
        value: 42,
        timeEpochMs: 1,
      })
    })

    // ── traces: parsed OTLP envelope, not empty ──────────────────────────────
    expect(traces.length).toBeGreaterThan(0)
    const spans = traces.flatMap((t) =>
      t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
    )
    // The internal `SPAN_NAMES.runSamplingRequest` id is re-mapped at the OTLP
    // export boundary to the pinned gen_ai span name. This span carries
    // `gen_ai.operation.name="chat"` but NO model attr, so the pinned name is the
    // BARE operation `"chat"` (the fallback when the model is unavailable). We key
    // on the operation ATTRIBUTE — the pin's stable discriminator.
    const chat = spans.find(
      (s) =>
        s.attributes.find((a) => a.key === GEN_AI_ATTRS.operation.name)?.value.stringValue ===
        "chat",
    )
    expect(chat).toBeDefined()
    // The pinned wire name for a model-less chat span is the bare operation.
    expect(chat?.name).toBe("chat")

    // (1) SPAN KIND reached the wire — CLIENT ⇒ OTLP enum 3.
    expect(chat?.kind).toBe(3)

    // (2) `gen_ai.operation.name` = "chat" reached the wire as a stringValue.
    const opName = chat?.attributes.find((a) => a.key === GEN_AI_ATTRS.operation.name)
    expect(opName).toBeDefined()
    expect(opName?.value.stringValue).toBe("chat")

    // ── metrics: parsed OTLP envelope carries the recorded histogram ─────────
    expect(metrics.length).toBeGreaterThan(0)
    const metricNames = metrics.flatMap((m) =>
      m.resourceMetrics.flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) => sm.metrics.map((x) => x.name)),
      ),
    )
    expect(metricNames).toContain("gen_ai.client.token.usage")
  })

  test("red-on-injection: capturing the WRONG path yields no chat span (proves the /v1/traces routing is real)", async () => {
    // If the harness bucketed metrics into `traces` (path confusion), the chat
    // span would be absent from `metrics`. Assert the split is by URL path.
    const { traces, metrics } = await captureOtlp(async () => {
      const span = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}), "client")
      endSpan(span, "ok", attrs({}))
    })
    const traceSpanCount = traces.flatMap((t) =>
      t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
    ).length
    expect(traceSpanCount).toBeGreaterThan(0)
    // No metric was recorded ⇒ the metrics leg is EMPTY (span did not leak into it).
    expect(metrics.length).toBe(0)
  })
})

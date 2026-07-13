/**
 * T-A0 — raw-OTLP proof harness.
 *
 * `captureOtlp(fn)` drives the REAL OTLP exporter (`otelHttpExporter`) over an
 * INJECTED fake `fetch` (the exporter's documented test seam,
 * `otel-exporter.ts:136-138,459`), captures the POST bodies it would send to a
 * collector at `/v1/traces` and `/v1/metrics`, and returns them PARSED so other
 * tickets can assert on the raw wire bytes — span names, OTLP span kinds,
 * attribute KEYS and value-TYPES (`stringValue`/`intValue`/…), metric units,
 * temporality, etc. NO live receiver is needed.
 *
 * Two ways to emit inside `fn` (both land on the same injected-fetch exporter):
 *   - the installed span sink: `startSpan`/`endSpan` from `@/observability`
 *     route through `createExporterSpanSink` (unified `{traceId,spanId}`), so a
 *     `chat` CLIENT span serialized to OTLP appears in the returned `traces`;
 *   - the live exporter handed to `fn` (`h.exporter`): call `recordSpan` /
 *     `recordMetric` directly to exercise the metric leg or bypass the sink.
 *
 * After `fn` resolves the harness `teardown()`s the exporter (final flush, no
 * timers — `flushIntervalMs: 0`), so every buffered span/metric is POSTed
 * through the fake fetch BEFORE we parse. The span sink is restored to whatever
 * was installed before (`setSpanSink(prev)`), so the harness is nestable and
 * leaves no global state behind.
 */

import { getSpanSink, setSpanSink } from "@/observability"
import type { OtelExporter } from "@/observability/otel-exporter"
import { otelHttpExporter } from "@/observability/otel-exporter"
import { createExporterSpanSink } from "@/observability/otel-span-export"

// ────────────────────────────────────────────────────────────────────────────
// Parsed OTLP/JSON wire shapes — the minimal subset this exporter emits
// (`serializeSpans`/`serializeMetrics` in otel-exporter.ts). Kept structural
// (not `unknown`) so downstream tickets get typed access to keys/value-types.
// ────────────────────────────────────────────────────────────────────────────

/** An OTLP `AnyValue` — a tagged union. Only the arms this exporter emits. */
export interface OtlpAnyValue {
  readonly stringValue?: string
  readonly doubleValue?: number
  readonly intValue?: number | string
  readonly boolValue?: boolean
  readonly arrayValue?: { readonly values: ReadonlyArray<OtlpAnyValue> }
}

export interface OtlpKeyValue {
  readonly key: string
  readonly value: OtlpAnyValue
}

export interface OtlpSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly name: string
  /** OTLP SpanKind enum: INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5. */
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: ReadonlyArray<OtlpKeyValue>
  readonly status: { readonly code: number; readonly message?: string }
}

export interface OtlpResourceSpans {
  readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
  readonly scopeSpans: ReadonlyArray<{
    readonly scope: { readonly name: string }
    readonly spans: ReadonlyArray<OtlpSpan>
  }>
}

/** One parsed `/v1/traces` POST body. */
export interface OtlpTracesEnvelope {
  readonly resourceSpans: ReadonlyArray<OtlpResourceSpans>
}

export interface OtlpDataPoint {
  readonly attributes: ReadonlyArray<OtlpKeyValue>
  readonly startTimeUnixNano: string
  readonly timeUnixNano: string
  readonly asDouble?: number
  readonly count?: string
  readonly sum?: number
}

export interface OtlpMetric {
  readonly name: string
  readonly unit?: string
  readonly description?: string
  readonly sum?: {
    readonly dataPoints: ReadonlyArray<OtlpDataPoint>
    readonly aggregationTemporality: number
    readonly isMonotonic: boolean
  }
  readonly histogram?: {
    readonly dataPoints: ReadonlyArray<OtlpDataPoint>
    readonly aggregationTemporality: number
  }
  readonly gauge?: { readonly dataPoints: ReadonlyArray<OtlpDataPoint> }
}

export interface OtlpResourceMetrics {
  readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
  readonly scopeMetrics: ReadonlyArray<{
    readonly scope: { readonly name: string }
    readonly metrics: ReadonlyArray<OtlpMetric>
  }>
}

/** One parsed `/v1/metrics` POST body. */
export interface OtlpMetricsEnvelope {
  readonly resourceMetrics: ReadonlyArray<OtlpResourceMetrics>
}

/** What `captureOtlp` returns: every parsed OTLP POST body, split by path.
 *  `traces[i]` is the JSON of the i-th `/v1/traces` POST, likewise `metrics`. */
export interface CapturedOtlp {
  readonly traces: ReadonlyArray<OtlpTracesEnvelope>
  readonly metrics: ReadonlyArray<OtlpMetricsEnvelope>
}

/** The live wiring handed to the driver `fn`. */
export interface OtlpCaptureHandle {
  /** The REAL exporter over the injected fake fetch. Call `recordSpan` /
   *  `recordMetric` to emit directly (the span sink also forwards here). */
  readonly exporter: OtelExporter
  /** The endpoint the fake fetch sees (`${endpoint}/v1/traces` etc.). */
  readonly endpoint: string
}

/** Options for `captureOtlp`. All defaulted — a bare `captureOtlp(fn)` works. */
export interface CaptureOtlpOpts {
  /** Base URL the exporter posts to. Default `http://otlp.test`. */
  readonly endpoint?: string
  /** Service name resource attr. Default the exporter's own default. */
  readonly serviceName?: string
  /** Run id resource attr (`quanta.run.id`). Default omitted. */
  readonly runId?: string
  /** When true, DON'T install `createExporterSpanSink` as the global span sink
   *  — the driver must emit via `h.exporter.recordSpan` only. Default false
   *  (sink installed, so `startSpan`/`endSpan` reach the wire). */
  readonly noSpanSink?: boolean
}

const DEFAULT_ENDPOINT = "http://otlp.test"

/**
 * Drive `fn` against a fetch-injected OTLP exporter and return the parsed wire
 * bodies. See the module header for the two emit paths.
 */
export const captureOtlp = async (
  fn: (h: OtlpCaptureHandle) => Promise<void> | void,
  opts: CaptureOtlpOpts = {},
): Promise<CapturedOtlp> => {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
  const traces: OtlpTracesEnvelope[] = []
  const metrics: OtlpMetricsEnvelope[] = []

  /** The injected fake `fetch` — record the POST body under the right bucket by
   *  URL path, then answer 200 so the exporter clears its buffer (a non-2xx
   *  would re-queue and we'd never see the bytes drain). */
  const fakeFetch = (async (
    input: string | URL,
    init?: { readonly body?: unknown },
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    const raw = typeof init?.body === "string" ? init.body : ""
    if (raw.length > 0) {
      const parsed: unknown = JSON.parse(raw)
      if (url.endsWith("/v1/traces")) {
        traces.push(parsed as OtlpTracesEnvelope)
      } else if (url.endsWith("/v1/metrics")) {
        metrics.push(parsed as OtlpMetricsEnvelope)
      }
    }
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch

  const exporter = otelHttpExporter({
    endpoint,
    fetch: fakeFetch,
    // Disable the recurring timer — the harness flushes deterministically at
    // teardown. A large batchSize keeps everything buffered until then, so one
    // POST per leg carries the whole run (not split across batch-flushes).
    flushIntervalMs: 0,
    batchSize: 1_000_000,
    ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  })

  const prevSink = getSpanSink()
  if (opts.noSpanSink !== true) setSpanSink(createExporterSpanSink(exporter))
  try {
    await fn({ exporter, endpoint })
  } finally {
    // Final flush drains both buffers through the fake fetch, THEN stop timers.
    await exporter.teardown()
    setSpanSink(prevSink)
  }

  return { traces, metrics }
}

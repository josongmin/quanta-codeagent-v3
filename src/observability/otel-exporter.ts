/**
 * OTLP/HTTP raw exporter — Default-OFF realtime export to an OTel Collector
 * (ADR-0237).
 *
 * Scope: the existing OTel scaffold (`metrics/otel-sink.ts`,
 * `tracing/otel-tracer.ts`, `tracing/w3c-propagator.ts`) gives us the
 * IN-PROCESS surface — counters, histograms, spans, propagation. What was
 * missing: actually shipping those observations to a collector when an
 * operator turns the surface on. This module closes that loop WITHOUT pulling
 * in the OTel SDK packages (`@opentelemetry/sdk-{metrics,trace-base}` +
 * exporter packages) — installs are blocked in this tree, and the SDK adds
 * ~500KB of bundle even when unused.
 *
 * Posture:
 *   - **OTLP/JSON over HTTP**. The Collector accepts the same payload shapes
 *     regardless of whether it came from the upstream OTel SDK or a hand-rolled
 *     serializer — the wire contract is the spec
 *     (https://opentelemetry.io/docs/specs/otlp/). We send the *minimal* span
 *     and metric fields: enough for any modern collector (Jaeger, Tempo,
 *     Honeycomb, Grafana Cloud, Datadog OTLP receiver) to ingest and render a
 *     trace tree / metric series. We do NOT implement OTLP/protobuf — JSON is
 *     accepted by every collector at `/v1/{traces,metrics}` and removes the
 *     protobuf runtime dep.
 *   - **Default-OFF**. Caller (composition root) MUST pass `endpoint` for
 *     anything to happen. The barrel exports the factory — wiring is a
 *     composition-root concern. The `attachOtelExporterFromEnv` helper reads
 *     `QUANTA_OTEL_ENDPOINT` and returns `undefined` when unset (no exporter
 *     ever instantiated → byte-identical to the no-op tracer/sink path).
 *   - **No-throw**. Every public method swallows network / serialization
 *     errors and logs to the optional `warn` sink. The buffer is NOT drained
 *     on failure so the next flush retries — but we also NEVER let an
 *     observability path break a tool call.
 *   - **Caller-injected `fetch` + `now` + `setInterval`-shaped scheduler**.
 *     Test seam: the hellgate drives the exporter with a fake fetch + fake
 *     clock + manual-tick scheduler so we can assert batch-size flush, time-
 *     based flush, and teardown without real timers.
 *   - **Plane-clean**. Imports only `./tracing/port` for the `SpanContext` /
 *     attribute primitives + nothing else from `@/agent`, `@/tool`, `@/llm`.
 *
 * The serializer is INTERNAL — callers construct typed `ExportSpan` /
 * `ExportMetric` records (the same shape that `metrics/otel-sink.ts` would
 * push into an OTel `Counter`/`Histogram`, and that `tracing/otel-tracer.ts`
 * would push into an OTel `Span`). Two attach helpers below glue:
 *   - `attachExporterToMetricSink(exporter)` returns a `MetricSink` that
 *     forwards every observation to the exporter (so an existing registry
 *     can `setSink` without knowing the exporter exists).
 *   - `buildExportingTracer(exporter, opts)` returns a `Tracer` whose
 *     `startSpan` allocates a real W3C-shaped span ID, records the span on
 *     `.end()` to the exporter's buffer, and otherwise behaves like the
 *     no-op tracer (no in-memory tree — the collector reconstructs).
 *
 * Why not just attach to the OTel SDK's MeterProvider/TracerProvider? Because
 * the SDK isn't installed and we explicitly do NOT auto-install. The cost of
 * this 200-line module is paid once and removes the SDK-version-coupling
 * surface entirely (the spec wire shape is stable; the SDK API churns).
 */

import type { MetricSink } from "./metrics/port"
import { noopTracer } from "./tracing/noop-tracer"
import type {
  Span,
  SpanAttributes,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  Tracer,
} from "./tracing/port"

// ────────────────────────────────────────────────────────────────────────────
// Export envelope shapes — the typed records that producers hand to the
// exporter. Intentionally minimal: only the fields that survive the OTLP/JSON
// wire format we emit.
// ────────────────────────────────────────────────────────────────────────────

/** One finished span ready for export. All timestamps are EPOCH MILLIS — the
 *  exporter converts to nanos at serialize time. */
export interface ExportSpan {
  /** 32-hex lowercase trace ID. */
  readonly traceId: string
  /** 16-hex lowercase span ID. */
  readonly spanId: string
  /** 16-hex lowercase parent span ID. Omitted for root spans. */
  readonly parentSpanId?: string
  readonly name: string
  /** OTel SpanKind — closed 5-arm union from `./tracing/port`. Default
   *  `"internal"` when omitted. */
  readonly kind?: SpanKind
  /** Span lifecycle status. Default `"unset"`. */
  readonly status?: SpanStatusCode
  /** Optional human-readable status message (only meaningful for `"error"`). */
  readonly statusMessage?: string
  readonly startTimeEpochMs: number
  readonly endTimeEpochMs: number
  readonly attributes?: SpanAttributes
}

/** One metric observation ready for export. Counter / histogram / gauge map to
 *  OTLP `sum` / `histogram` / `gauge` respectively. */
export interface ExportMetric {
  readonly name: string
  readonly kind: "counter" | "histogram" | "gauge"
  readonly value: number
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
  readonly timeEpochMs: number
}

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface OtelExporterOpts {
  /** OTLP collector base URL. Examples:
   *   - `http://localhost:4318` (collector with default OTLP/HTTP receiver)
   *   - `https://api.honeycomb.io` (managed)
   *  The exporter appends `/v1/traces` and `/v1/metrics`. */
  readonly endpoint: string
  /** `fetch` implementation. Default = global `fetch`. Test seam — the
   *  hellgate injects a fake. */
  readonly fetch?: typeof fetch
  /** Headers added to every request (auth, x-honeycomb-team, etc.). */
  readonly headers?: Readonly<Record<string, string>>
  /** Service name attribute attached to every span/metric resource. Default
   *  `"quanta-codeagent"`. */
  readonly serviceName?: string
  /** Batch size — when the in-memory buffer reaches this many spans (or
   *  metrics, counted separately), the exporter triggers an immediate flush.
   *  Default `64`. */
  readonly batchSize?: number
  /** Flush interval in millis. The exporter schedules a flush on a recurring
   *  timer. Default `5000` (5s). Set to `0` to disable the timer entirely
   *  (caller flushes manually). */
  readonly flushIntervalMs?: number
  /** Clock — default `Date.now`. Test seam for deterministic timestamps. */
  readonly now?: () => number
  /** `setInterval` test seam — when present, the exporter uses this to
   *  schedule the recurring flush. Default = `globalThis.setInterval` cast to
   *  the matching signature. The seam returns a typed handle and the
   *  exporter holds onto it for `teardown`. */
  readonly setIntervalImpl?: (callback: () => void, ms: number) => IntervalHandle
  /** `clearInterval` test seam — paired with `setIntervalImpl`. Default =
   *  `globalThis.clearInterval`. */
  readonly clearIntervalImpl?: (handle: IntervalHandle) => void
  /** Optional warn sink. No-throw — caller's logger. The exporter calls this
   *  on serialization / network errors. Absent ⇒ silent. */
  readonly warn?: (msg: string) => void
}

/** Opaque interval handle. Real `setInterval` returns `Timeout` on Node / a
 *  number in browser; the exporter doesn't inspect the value — only passes it
 *  back to `clearInterval`. */
// biome-ignore lint/suspicious/noExplicitAny: opaque test-seam handle
export type IntervalHandle = any

export interface OtelExporter {
  /** Buffer a span for export. Triggers an immediate flush if the buffer
   *  reaches `batchSize`. */
  recordSpan(span: ExportSpan): void
  /** Buffer a metric for export. Triggers an immediate flush if the metric
   *  buffer reaches `batchSize`. */
  recordMetric(metric: ExportMetric): void
  /** Force a flush of both buffers. Resolves when the HTTP POSTs settle (or
   *  immediately when both buffers are empty). No-throw — failures keep the
   *  buffer populated for the next flush. */
  flush(): Promise<void>
  /** Final flush + stop the interval timer. After teardown, `recordSpan` /
   *  `recordMetric` still buffer (no-throw); the caller is responsible for
   *  not calling them in steady state. */
  teardown(): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SERVICE_NAME = "quanta-codeagent"
const DEFAULT_BATCH_SIZE = 64
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const TRACES_PATH = "/v1/traces"
const METRICS_PATH = "/v1/metrics"

// ────────────────────────────────────────────────────────────────────────────
// OTLP/JSON serialization helpers — minimal field set per spec.
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto
// ────────────────────────────────────────────────────────────────────────────

/** Map our SpanKind union to the OTLP enum integer (SPAN_KIND_UNSPECIFIED=0,
 *  INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5). The exhaustive
 *  switch + `never` fallthrough means a future addition to the union triggers
 *  a compile error here. */
const otlpKind = (kind: SpanKind | undefined): number => {
  if (kind === undefined) return 1 // INTERNAL
  switch (kind) {
    case "internal":
      return 1
    case "server":
      return 2
    case "client":
      return 3
    case "producer":
      return 4
    case "consumer":
      return 5
    default: {
      const _exhaustive: never = kind
      void _exhaustive
      return 1
    }
  }
}

/** Map our status union to OTLP StatusCode (UNSET=0, OK=1, ERROR=2). */
const otlpStatusCode = (code: SpanStatusCode | undefined): number => {
  if (code === undefined) return 0
  switch (code) {
    case "unset":
      return 0
    case "ok":
      return 1
    case "error":
      return 2
    default: {
      const _exhaustive: never = code
      void _exhaustive
      return 0
    }
  }
}

/** Convert a typed attribute map → OTLP KeyValue list. OTLP attribute values
 *  are tagged unions (`stringValue` / `intValue` / `doubleValue` / `boolValue`).
 *  We pick the tag by JS typeof — number → doubleValue (collectors handle the
 *  cast). */
const otlpAttributes = (
  attrs: Readonly<Record<string, string | number | boolean>> | undefined,
): Array<Record<string, unknown>> => {
  if (attrs === undefined) return []
  const out: Array<Record<string, unknown>> = []
  for (const k of Object.keys(attrs)) {
    const v = attrs[k]
    if (typeof v === "string") {
      out.push({ key: k, value: { stringValue: v } })
    } else if (typeof v === "number") {
      out.push({ key: k, value: { doubleValue: v } })
    } else if (typeof v === "boolean") {
      out.push({ key: k, value: { boolValue: v } })
    }
  }
  return out
}

/** Convert epoch millis → string of unix nanos. OTLP requires nanos as a
 *  STRING to avoid 64-bit precision loss in JSON (per spec). We multiply once
 *  by 1e6 and convert to string. */
const nanos = (epochMs: number): string => `${Math.trunc(epochMs * 1_000_000)}`

const buildResource = (serviceName: string): Record<string, unknown> => ({
  attributes: otlpAttributes({ "service.name": serviceName }),
})

/** Serialize an array of spans → OTLP/JSON `resourceSpans` envelope. */
const serializeSpans = (
  spans: ReadonlyArray<ExportSpan>,
  serviceName: string,
): Record<string, unknown> => ({
  resourceSpans: [
    {
      resource: buildResource(serviceName),
      scopeSpans: [
        {
          scope: { name: "quanta" },
          spans: spans.map((s) => {
            const out: Record<string, unknown> = {
              traceId: s.traceId,
              spanId: s.spanId,
              name: s.name,
              kind: otlpKind(s.kind),
              startTimeUnixNano: nanos(s.startTimeEpochMs),
              endTimeUnixNano: nanos(s.endTimeEpochMs),
              attributes: otlpAttributes(s.attributes),
              status: {
                code: otlpStatusCode(s.status),
                ...(s.statusMessage !== undefined && s.status === "error"
                  ? { message: s.statusMessage }
                  : {}),
              },
            }
            if (s.parentSpanId !== undefined) out.parentSpanId = s.parentSpanId
            return out
          }),
        },
      ],
    },
  ],
})

/** Serialize an array of metrics → OTLP/JSON `resourceMetrics` envelope. Each
 *  metric is its own entry — we do NOT cross-aggregate samples with the same
 *  name in this exporter (the collector handles that). Counter → `sum`,
 *  histogram → `histogram` (single-point dataPoint), gauge → `gauge`. */
const serializeMetrics = (
  ms: ReadonlyArray<ExportMetric>,
  serviceName: string,
): Record<string, unknown> => ({
  resourceMetrics: [
    {
      resource: buildResource(serviceName),
      scopeMetrics: [
        {
          scope: { name: "quanta" },
          metrics: ms.map((m) => {
            const dp = {
              attributes: otlpAttributes(m.attributes),
              startTimeUnixNano: nanos(m.timeEpochMs),
              timeUnixNano: nanos(m.timeEpochMs),
              asDouble: m.value,
            }
            if (m.kind === "counter") {
              return {
                name: m.name,
                sum: {
                  dataPoints: [dp],
                  aggregationTemporality: 2, // CUMULATIVE
                  isMonotonic: true,
                },
              }
            }
            if (m.kind === "histogram") {
              return {
                name: m.name,
                histogram: {
                  dataPoints: [
                    {
                      attributes: dp.attributes,
                      startTimeUnixNano: dp.startTimeUnixNano,
                      timeUnixNano: dp.timeUnixNano,
                      count: "1",
                      sum: m.value,
                    },
                  ],
                  aggregationTemporality: 2,
                },
              }
            }
            // gauge
            return {
              name: m.name,
              gauge: { dataPoints: [dp] },
            }
          }),
        },
      ],
    },
  ],
})

// ────────────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────────────

/** Construct an OTLP/HTTP exporter. The returned instance buffers spans +
 *  metrics in memory, flushes on `batchSize` reach OR every
 *  `flushIntervalMs`, and tears down via `teardown()` (flush + clear timer). */
export const otelHttpExporter = (opts: OtelExporterOpts): OtelExporter => {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch)
  const serviceName = opts.serviceName ?? DEFAULT_SERVICE_NAME
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const setIntervalImpl =
    opts.setIntervalImpl ??
    ((cb: () => void, ms: number): IntervalHandle => globalThis.setInterval(cb, ms))
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: IntervalHandle): void => {
      globalThis.clearInterval(handle)
    })
  const warn = opts.warn

  // Normalize endpoint — strip trailing slash so we can append `/v1/traces`.
  const endpoint = opts.endpoint.endsWith("/") ? opts.endpoint.slice(0, -1) : opts.endpoint

  const spanBuffer: ExportSpan[] = []
  const metricBuffer: ExportMetric[] = []

  const safeWarn = (msg: string): void => {
    if (warn === undefined) return
    try {
      warn(msg)
    } catch {
      // even the warn sink may throw — swallow
    }
  }

  /** POST one envelope to `${endpoint}${path}`. Returns true on 2xx, false on
   *  any other status / throw. The caller decides whether to clear the
   *  buffer (only on `true`). */
  const post = async (path: string, body: unknown): Promise<boolean> => {
    let serialized: string
    try {
      serialized = JSON.stringify(body)
    } catch (e) {
      safeWarn(`[otel-exporter] serialize ${path}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
    try {
      const res = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers ?? {}),
        },
        body: serialized,
      })
      if (!res.ok) {
        safeWarn(`[otel-exporter] POST ${path} → HTTP ${res.status}`)
        return false
      }
      return true
    } catch (e) {
      safeWarn(`[otel-exporter] POST ${path}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /** Drain the span buffer to the collector. On failure, the buffer is
   *  preserved (next flush retries — no infinite growth because batchSize
   *  caps the buffer in practice, but the operator can detect via warn). */
  const flushSpans = async (): Promise<void> => {
    if (spanBuffer.length === 0) return
    const snapshot = spanBuffer.slice()
    const ok = await post(TRACES_PATH, serializeSpans(snapshot, serviceName))
    if (ok) {
      // Remove the snapshot entries from the front of the buffer.
      spanBuffer.splice(0, snapshot.length)
    }
  }

  const flushMetrics = async (): Promise<void> => {
    if (metricBuffer.length === 0) return
    const snapshot = metricBuffer.slice()
    const ok = await post(METRICS_PATH, serializeMetrics(snapshot, serviceName))
    if (ok) {
      metricBuffer.splice(0, snapshot.length)
    }
  }

  // Serialize concurrent flushes — a fire-and-forget batch-size flush and an
  // awaited explicit flush can collide. The upstream OTLP/HTTP exporter has
  // the same invariant: at most one in-flight POST per stream. We use a
  // simple Promise queue: when a flush is in-flight, the next caller awaits
  // the same promise; new buffer entries arriving DURING the in-flight flush
  // are picked up by the NEXT flush.
  let inFlight: Promise<void> | undefined
  const flushAll = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    const p = (async () => {
      try {
        await flushSpans()
        await flushMetrics()
      } finally {
        inFlight = undefined
      }
    })()
    inFlight = p
    return p
  }

  // Schedule recurring flush. Interval=0 disables the timer entirely.
  let intervalHandle: IntervalHandle | undefined
  if (flushIntervalMs > 0) {
    intervalHandle = setIntervalImpl(() => {
      // The interval callback runs flushAll but does not await it — failures
      // are logged via safeWarn inside `post`.
      void flushAll()
    }, flushIntervalMs)
  }

  return {
    recordSpan(span) {
      spanBuffer.push(span)
      if (spanBuffer.length >= batchSize) {
        // Fire-and-forget — recordSpan is sync to match the tracer surface.
        // The flush awaits inside.
        void flushAll()
      }
    },
    recordMetric(metric) {
      metricBuffer.push(metric)
      if (metricBuffer.length >= batchSize) {
        void flushAll()
      }
    },
    async flush() {
      await flushAll()
    },
    async teardown() {
      if (intervalHandle !== undefined) {
        try {
          clearIntervalImpl(intervalHandle)
        } catch {
          // Swallow — clearInterval almost never throws but be defensive.
        }
        intervalHandle = undefined
      }
      await flushAll()
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sink + tracer adapters — small bridge fns so a composition root that
// already has `MetricsRegistry` / `Tracer` wired can plug the exporter in
// without restructuring.
// ────────────────────────────────────────────────────────────────────────────

/** Wrap an exporter as a `MetricSink`. Every `send` is forwarded to the
 *  exporter's metric buffer. `flush` delegates to the exporter (so a registry
 *  that calls `sink.flush()` on shutdown drains the network too).
 *
 *  No clock parameter: `MetricSample` already carries its own `at` epoch-ms
 *  field (set by the registry that recorded the sample), so the wire
 *  timestamp is preserved verbatim. */
export const exporterMetricSink = (exporter: OtelExporter): MetricSink => ({
  send(sample) {
    exporter.recordMetric({
      name: sample.name,
      kind: sample.kind,
      value: sample.value,
      ...(sample.labels !== undefined ? { attributes: sample.labels } : {}),
      timeEpochMs: sample.at,
    })
  },
  async flush() {
    await exporter.flush()
  },
})

/** Hex random for trace/span IDs. Mirrors `noop-tracer.randomHex` so the
 *  exporting tracer produces W3C-shaped IDs (32/16 hex). */
const randomHex = (byteCount: number): string => {
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += (b < 0x10 ? "0" : "") + b.toString(16)
  }
  return out
}

interface ExportingTracerOpts {
  /** Clock. Default `Date.now`. */
  readonly now?: () => number
}

/** Build a `Tracer` that produces W3C-shaped spans and forwards finished spans
 *  to the exporter on `end()`. Parent spans are honored: the trace ID is
 *  inherited from the parent. This tracer keeps NO in-memory tree — the
 *  collector reconstructs the parent/child links via `parentSpanId`. */
export const buildExportingTracer = (
  exporter: OtelExporter,
  opts?: ExportingTracerOpts,
): Tracer => {
  const now = opts?.now ?? Date.now

  // Helper: project a Span | SpanContext | undefined → SpanContext | undefined.
  const resolveParentCtx = (parent: SpanContext | Span | undefined): SpanContext | undefined => {
    if (parent === undefined) return undefined
    if ("context" in parent) return parent.context
    return parent
  }

  // Helper: copy starting attributes into a fresh mutable record. Keeps the
  // type-narrowing check colocated and out of the hot path's outer scope.
  const initAttrs = (
    initial: SpanAttributes | undefined,
  ): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {}
    if (initial === undefined) return out
    for (const k of Object.keys(initial)) {
      const v = initial[k]
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = v
      }
    }
    return out
  }

  // Helper: build the ExportSpan envelope at end() time. All optional-fence
  // spreads live here so the `end()` closure stays small.
  const buildExportSpan = (args: {
    readonly traceId: string
    readonly spanId: string
    readonly parentCtx: SpanContext | undefined
    readonly name: string
    readonly kind: SpanKind | undefined
    readonly status: SpanStatusCode
    readonly statusMessage: string | undefined
    readonly startTimeEpochMs: number
    readonly endTimeEpochMs: number
    readonly attrs: Record<string, string | number | boolean>
  }): ExportSpan => ({
    traceId: args.traceId,
    spanId: args.spanId,
    ...(args.parentCtx !== undefined ? { parentSpanId: args.parentCtx.spanId } : {}),
    name: args.name,
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    status: args.status,
    ...(args.statusMessage !== undefined ? { statusMessage: args.statusMessage } : {}),
    startTimeEpochMs: args.startTimeEpochMs,
    endTimeEpochMs: args.endTimeEpochMs,
    ...(Object.keys(args.attrs).length > 0 ? { attributes: args.attrs } : {}),
  })

  const buildSpan = (
    name: string,
    spanOpts:
      | {
          readonly kind?: SpanKind
          readonly parent?: SpanContext | Span
          readonly attributes?: SpanAttributes
          readonly startTime?: number
        }
      | undefined,
  ): Span => {
    const parentCtx = resolveParentCtx(spanOpts?.parent)
    const traceId = parentCtx?.traceId ?? randomHex(16)
    const spanId = randomHex(8)
    const traceFlags = parentCtx?.traceFlags ?? 1 // sampled
    const context: SpanContext = { traceId, spanId, traceFlags }
    const startTimeEpochMs = spanOpts?.startTime ?? now()
    const attrs = initAttrs(spanOpts?.attributes)
    let status: SpanStatusCode = "unset"
    let statusMessage: string | undefined
    let ended = false

    return {
      context,
      setAttribute(key, value) {
        attrs[key] = value
      },
      setStatus(code, message) {
        status = code
        if (message !== undefined) statusMessage = message
      },
      recordException(error) {
        attrs["exception.type"] = error.name
        attrs["exception.message"] = error.message
        if (error.stack !== undefined) attrs["exception.stacktrace"] = error.stack
      },
      end(endTime) {
        if (ended) return
        ended = true
        const exportSpan = buildExportSpan({
          traceId,
          spanId,
          parentCtx,
          name,
          kind: spanOpts?.kind,
          status,
          statusMessage,
          startTimeEpochMs,
          endTimeEpochMs: endTime ?? now(),
          attrs,
        })
        try {
          exporter.recordSpan(exportSpan)
        } catch {
          // exporter buffer can never throw, but be defensive.
        }
      },
    }
  }

  return {
    startSpan(name, spanOpts) {
      try {
        return buildSpan(name, spanOpts)
      } catch {
        // Pathological — fall back to no-op so callers aren't crashed.
        return noopTracer.startSpan(name, spanOpts)
      }
    },
    async withSpan(name, fn, spanOpts) {
      const span = this.startSpan(name, spanOpts)
      try {
        const out = await fn(span)
        span.setStatus("ok")
        return out
      } catch (e) {
        if (e instanceof Error) {
          span.recordException(e)
          span.setStatus("error", e.message)
        } else {
          span.setStatus("error", String(e))
        }
        throw e
      } finally {
        span.end()
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Env-driven composition helper — read QUANTA_OTEL_ENDPOINT and build the
// exporter + sink + tracer triplet. Returns `undefined` when the env var is
// unset, blank, or otherwise unusable → composition root continues with its
// no-op defaults (byte-identical Default-OFF posture).
// ────────────────────────────────────────────────────────────────────────────

export interface OtelExporterFromEnvResult {
  readonly exporter: OtelExporter
  readonly metricSink: MetricSink
  readonly tracer: Tracer
}

/** Read `QUANTA_OTEL_ENDPOINT` from the provided env (default `process.env`)
 *  and build a wired triple. Returns `undefined` when the env value is
 *  missing/empty/whitespace.
 *
 *  Additional env knobs honored:
 *   - `QUANTA_OTEL_SERVICE_NAME` (default `"quanta-codeagent"`)
 *   - `QUANTA_OTEL_BATCH_SIZE` (default `64`)
 *   - `QUANTA_OTEL_FLUSH_MS` (default `5000`)
 *
 *  All three are optional — caller can also override programmatically via
 *  `overrides`. The endpoint MUST come from the env var (composition root
 *  policy: a default endpoint would silently leak observations to localhost).
 */
export const attachOtelExporterFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Partial<OtelExporterOpts>,
): OtelExporterFromEnvResult | undefined => {
  const rawEndpoint = env.QUANTA_OTEL_ENDPOINT ?? overrides?.endpoint
  if (rawEndpoint === undefined) return undefined
  const endpoint = rawEndpoint.trim()
  if (endpoint.length === 0) return undefined

  const serviceName = overrides?.serviceName ?? env.QUANTA_OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME

  const parseIntEnv = (val: string | undefined, fallback: number): number => {
    if (val === undefined) return fallback
    const n = Number.parseInt(val, 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const batchSize =
    overrides?.batchSize ?? parseIntEnv(env.QUANTA_OTEL_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  const flushIntervalMs =
    overrides?.flushIntervalMs ?? parseIntEnv(env.QUANTA_OTEL_FLUSH_MS, DEFAULT_FLUSH_INTERVAL_MS)

  const exporter = otelHttpExporter({
    endpoint,
    serviceName,
    batchSize,
    flushIntervalMs,
    ...(overrides?.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides?.headers !== undefined ? { headers: overrides.headers } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides?.setIntervalImpl !== undefined
      ? { setIntervalImpl: overrides.setIntervalImpl }
      : {}),
    ...(overrides?.clearIntervalImpl !== undefined
      ? { clearIntervalImpl: overrides.clearIntervalImpl }
      : {}),
    ...(overrides?.warn !== undefined ? { warn: overrides.warn } : {}),
  })
  const metricSink = exporterMetricSink(exporter)
  const tracer = buildExportingTracer(
    exporter,
    overrides?.now !== undefined ? { now: overrides.now } : undefined,
  )

  return { exporter, metricSink, tracer }
}

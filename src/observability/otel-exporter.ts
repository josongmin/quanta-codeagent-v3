/**
 * OTLP/HTTP raw exporter — Default-OFF realtime export to an OTel Collector
 * (ADR-0268).
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

import { errMessage } from "@/shared"
import type { MetricSink } from "./metrics/port"
import type { ExportMetric, ExportSpan } from "./otel-exporter/otlp-encode"
import { serializeMetrics, serializeSpans } from "./otel-exporter/otlp-encode"
import { hexId } from "./tracing/hex-id"
import { noopTracer } from "./tracing/noop-tracer"
import type {
  Span,
  SpanAttributes,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  Tracer,
} from "./tracing/port"

// The wire types moved DOWN with the encoder that owns them; re-exported here so
// every existing importer of `@/observability/otel-exporter` is unaffected.
export type {
  ExportMetric,
  ExportSpan,
  SpanExportAttributes,
} from "./otel-exporter/otlp-encode"

// ────────────────────────────────────────────────────────────────────────────
// Export envelope shapes — the typed records that producers hand to the
// exporter. Intentionally minimal: only the fields that survive the OTLP/JSON
// wire format we emit.
// ────────────────────────────────────────────────────────────────────────────

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
  /** Headers added to every request (auth, x-honeycomb-team, etc.). STATIC —
   *  resolved once at construction. For a ROTATING credential (OAuth bearer
   *  against an OTLP collector), use {@link getHeaders} instead/alongside. */
  readonly headers?: Readonly<Record<string, string>>
  /** §12.7 — DYNAMIC headers port (the `otelHeadersHelper` pattern). When
   *  present, the exporter `await`s this callback before EACH POST and merges
   *  the result over {@link headers} (dynamic keys win), so a rotating OAuth
   *  token is always fresh — unlike a static header that 401s once it expires.
   *
   *  No-throw by contract: a rejection / throw is swallowed (logged via
   *  {@link warn}) and the POST proceeds with the STATIC {@link headers} as
   *  fallback — an observability path must never break a tool call, and a token
   *  endpoint blip should degrade to "send with the last static creds", not
   *  drop the batch. The buffer is preserved on any non-2xx, so a refreshed
   *  token on the next flush drains the retained spans.
   *
   *  Absent (the default) ⇒ the exporter uses the static {@link headers} on
   *  every POST exactly as before (byte-identical Default-OFF). */
  readonly getHeaders?: () => Promise<Readonly<Record<string, string>>>
  /** Service name attribute attached to every span/metric resource. Default
   *  `"quanta-codeagent"`. */
  readonly serviceName?: string
  /** Run id — attached as the `quanta.run.id` resource attribute on every
   *  span/metric when set. Lets the trace-viewer filter ONE bench run out of a
   *  sink that mixes many (the `?run=<id>` deep-link). Absent ⇒ no attribute
   *  (byte-identical Default-OFF). */
  readonly runId?: string
  /** Batch size — when the in-memory buffer reaches this many spans (or
   *  metrics, counted separately), the exporter triggers an immediate flush.
   *  Default `64`. */
  readonly batchSize?: number
  /** Flush interval in millis. The exporter schedules a flush on a recurring
   *  timer. Default `5000` (5s). Set to `0` to disable the timer entirely
   *  (caller flushes manually). */
  readonly flushIntervalMs?: number
  /** Hard cap on each in-memory buffer (spans + metrics counted separately).
   *  When a flush keeps FAILING (collector down) the buffer would otherwise
   *  grow without bound and OOM the process (audit L9 H1). On overflow the
   *  OLDEST entries are dropped to make room for the newest (most-recent
   *  observability is the most useful), and a `warn` is emitted. Default
   *  `10_000`. Must be ≥ `batchSize`. */
  readonly maxBufferSize?: number
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
const DEFAULT_MAX_BUFFER_SIZE = 10_000
const TRACES_PATH = "/v1/traces"
const METRICS_PATH = "/v1/metrics"

// ────────────────────────────────────────────────────────────────────────────
// OTLP/JSON serialization helpers — minimal field set per spec.
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * The OTLP transport: resolve headers, POST one envelope, and the two buffer
 * flushes built on it.
 *
 * The flush logic is the reason this is worth naming. It takes the whole buffer
 * out BY IDENTITY and clears it, so records arriving during the awaited POST
 * land in the now-empty buffer; on failure the unsent snapshot is re-queued
 * AHEAD of the newcomers and the cap re-applied. Indexing by front-count
 * instead would drop unsent records beyond the documented drop-oldest policy
 * whenever `boundedPush` evicted from the front mid-flush (audit R1 D-F1).
 *
 * Extracted from {@link otelHttpExporter} (god-function burndown).
 */
const buildOtlpTransport = (
  opts: OtelExporterOpts,
  ctx: {
    readonly fetchImpl: typeof fetch
    readonly endpoint: string
    readonly serviceName: string
    readonly runId: string | undefined
    readonly maxBufferSize: number
    readonly spanBuffer: ExportSpan[]
    readonly metricBuffer: ExportMetric[]
    readonly overflowWarned: { span: boolean; metric: boolean }
    readonly safeWarn: (message: string) => void
  },
): {
  readonly flushSpans: () => Promise<void>
  readonly flushMetrics: () => Promise<void>
} => {
  const {
    fetchImpl,
    endpoint,
    serviceName,
    runId,
    maxBufferSize,
    spanBuffer,
    metricBuffer,
    overflowWarned,
    safeWarn,
  } = ctx
  const resolveHeaders = async (): Promise<Record<string, string>> => {
    const staticHeaders = { ...(opts.headers ?? {}) }
    if (opts.getHeaders === undefined) return staticHeaders
    try {
      const dynamic = await opts.getHeaders()
      return { ...staticHeaders, ...dynamic }
    } catch (e) {
      safeWarn(`[otel-exporter] getHeaders: ${errMessage(e)} (falling back to static headers)`)
      return staticHeaders
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
      safeWarn(`[otel-exporter] serialize ${path}: ${errMessage(e)}`)
      return false
    }
    const dynamicHeaders = await resolveHeaders()
    try {
      const res = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...dynamicHeaders,
        },
        body: serialized,
      })
      if (!res.ok) {
        safeWarn(`[otel-exporter] POST ${path} → HTTP ${res.status}`)
        return false
      }
      return true
    } catch (e) {
      safeWarn(`[otel-exporter] POST ${path}: ${errMessage(e)}`)
      return false
    }
  }

  /** Drain the span buffer to the collector. On failure, the buffer is
   *  preserved (next flush retries — no infinite growth because batchSize
   *  caps the buffer in practice, but the operator can detect via warn). */
  const flushSpans = async (): Promise<void> => {
    if (spanBuffer.length === 0) return
    // Take the whole buffer out by identity and clear it. Records that arrive
    // DURING the awaited POST land in the now-empty buffer; the success path
    // must never index by front-count, because boundedPush may have evicted the
    // in-flight entries from the front mid-flush — that would drop UNSENT
    // records beyond the documented drop-oldest overflow policy (audit R1 D-F1).
    const snapshot = spanBuffer.splice(0, spanBuffer.length)
    const ok = await post(TRACES_PATH, serializeSpans(snapshot, serviceName, runId))
    if (ok) {
      if (spanBuffer.length < maxBufferSize) overflowWarned.span = false
    } else {
      // Failed — re-queue the unsent snapshot ahead of any newcomers, then
      // re-apply the cap (drop-oldest) so the buffer cannot grow unbounded.
      spanBuffer.unshift(...snapshot)
      if (spanBuffer.length > maxBufferSize) {
        spanBuffer.splice(0, spanBuffer.length - maxBufferSize)
      }
    }
  }

  const flushMetrics = async (): Promise<void> => {
    if (metricBuffer.length === 0) return
    const snapshot = metricBuffer.splice(0, metricBuffer.length)
    const ok = await post(METRICS_PATH, serializeMetrics(snapshot, serviceName, runId))
    if (ok) {
      if (metricBuffer.length < maxBufferSize) overflowWarned.metric = false
    } else {
      metricBuffer.unshift(...snapshot)
      if (metricBuffer.length > maxBufferSize) {
        metricBuffer.splice(0, metricBuffer.length - maxBufferSize)
      }
    }
  }

  // Serialize concurrent flushes — a fire-and-forget batch-size flush and an
  // awaited explicit flush can collide. The upstream OTLP/HTTP exporter has
  // the same invariant: at most one in-flight POST per stream. We use a
  // simple Promise queue: when a flush is in-flight, the next caller awaits
  // the same promise; new buffer entries arriving DURING the in-flight flush
  // are picked up by the NEXT flush.
  return { flushSpans, flushMetrics }
}

/** Construct an OTLP/HTTP exporter. The returned instance buffers spans +
 *  metrics in memory, flushes on `batchSize` reach OR every
 *  `flushIntervalMs`, and tears down via `teardown()` (flush + clear timer). */
export const otelHttpExporter = (opts: OtelExporterOpts): OtelExporter => {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch)
  const serviceName = opts.serviceName ?? DEFAULT_SERVICE_NAME
  const runId = opts.runId
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  // Buffer cap is at least `batchSize` so a single batch always fits.
  const maxBufferSize = Math.max(opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE, batchSize)
  const setIntervalImpl =
    opts.setIntervalImpl ??
    ((cb: () => void, ms: number): IntervalHandle => {
      // `unref()` so the recurring flush timer does NOT keep the Node event
      // loop alive on its own (audit L9 M3 timer-exit): a short-lived CLI run
      // that turned the exporter on would otherwise HANG at exit waiting on
      // this interval. `teardown()` clears it for graceful shutdown; `unref`
      // covers the path where the process is otherwise idle and should exit.
      const handle = globalThis.setInterval(cb, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
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
  // Coalesce the overflow warning so a wedged collector doesn't produce one
  // warn line per dropped record (which would just relocate the DoS to the
  // logger). One warn per buffer until it next drains below the cap.
  /** Overflow-warned latches. A HOLDER because both `boundedPush` (which stays
   *  in the factory) and the flush paths (which do not) latch and clear them. */
  const overflowWarned = { span: false, metric: false }

  const safeWarn = (msg: string): void => {
    if (warn === undefined) return
    try {
      warn(msg)
    } catch {
      // even the warn sink may throw — swallow
    }
  }

  /** Push `entry` onto `buf`, dropping the OLDEST entries when the cap would be
   *  exceeded (audit L9 H1 — bound the in-memory buffer so a permanently
   *  unreachable collector cannot OOM the process). Returns true if anything
   *  was dropped. */
  const boundedPush = <T>(buf: T[], entry: T): boolean => {
    buf.push(entry)
    if (buf.length <= maxBufferSize) return false
    buf.splice(0, buf.length - maxBufferSize)
    return true
  }

  /** Resolve the per-POST header set. Static {@link OtelExporterOpts.headers}
   *  is the base; when {@link OtelExporterOpts.getHeaders} is present its
   *  awaited result is merged ON TOP (dynamic keys override static). A
   *  throw/rejection from the dynamic port is swallowed (no-throw) and we fall
   *  back to the static headers — a rotating-token endpoint blip degrades to
   *  "send with last static creds", never drops the batch. */
  const { flushSpans, flushMetrics } = buildOtlpTransport(opts, {
    fetchImpl,
    endpoint,
    serviceName,
    runId,
    maxBufferSize,
    spanBuffer,
    metricBuffer,
    overflowWarned,
    safeWarn,
  })
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
      if (boundedPush(spanBuffer, span) && !overflowWarned.span) {
        overflowWarned.span = true
        safeWarn(
          `[otel-exporter] span buffer hit cap (${maxBufferSize}) — dropping oldest spans (collector unreachable?)`,
        )
      }
      if (spanBuffer.length >= batchSize) {
        // Fire-and-forget — recordSpan is sync to match the tracer surface.
        // The flush awaits inside.
        void flushAll()
      }
    },
    recordMetric(metric) {
      if (boundedPush(metricBuffer, metric) && !overflowWarned.metric) {
        overflowWarned.metric = true
        safeWarn(
          `[otel-exporter] metric buffer hit cap (${maxBufferSize}) — dropping oldest metrics (collector unreachable?)`,
        )
      }
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
      // Carry the descriptor-level metadata to the wire ONLY when declared, so
      // legacy (unit-less) samples stay byte-identical. (T-C1)
      ...(sample.unit !== undefined ? { unit: sample.unit } : {}),
      ...(sample.description !== undefined ? { description: sample.description } : {}),
    })
  },
  async flush() {
    await exporter.flush()
  },
})

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
    const traceId = parentCtx?.traceId ?? hexId(16)
    const spanId = hexId(8)
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
          span.setStatus("error", errMessage(e))
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

/** Read `QUANTA_OTEL_ENDPOINT` from the provided env record and build a wired
 *  triple. Returns `undefined` when the env value is
 *  missing/empty/whitespace.
 *
 *  Additional env knobs honored:
 *   - `QUANTA_OTEL_SERVICE_NAME` (default `"quanta-codeagent"`)
 *   - `QUANTA_OTEL_RUN_ID` (optional; `quanta.run.id` resource attr → `?run=` filter)
 *   - `QUANTA_OTEL_BATCH_SIZE` (default `64`)
 *   - `QUANTA_OTEL_FLUSH_MS` (default `5000`)
 *
 *  All three are optional — caller can also override programmatically via
 *  `overrides`. The endpoint MUST come from the env var (composition root
 *  policy: a default endpoint would silently leak observations to localhost).
 */
export const attachOtelExporterFromEnv = (
  env: Readonly<Record<string, string | undefined>> = {},
  overrides?: Partial<OtelExporterOpts>,
): OtelExporterFromEnvResult | undefined => {
  const rawEndpoint = env.QUANTA_OTEL_ENDPOINT ?? overrides?.endpoint
  if (rawEndpoint === undefined) return undefined
  const endpoint = rawEndpoint.trim()
  if (endpoint.length === 0) return undefined

  const serviceName = overrides?.serviceName ?? env.QUANTA_OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME
  // Run id (`quanta.run.id` resource attr) → the trace-viewer `?run=<id>` filter.
  // Trimmed; a blank env value is treated as unset (no attribute, byte-identical).
  const runIdRaw = overrides?.runId ?? env.QUANTA_OTEL_RUN_ID
  const runId = runIdRaw !== undefined && runIdRaw.trim() !== "" ? runIdRaw.trim() : undefined

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
    ...(runId !== undefined ? { runId } : {}),
    batchSize,
    flushIntervalMs,
    ...(overrides?.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides?.headers !== undefined ? { headers: overrides.headers } : {}),
    ...(overrides?.getHeaders !== undefined ? { getHeaders: overrides.getHeaders } : {}),
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

/**
 * OTLP/HTTP JSON wire encoding — the pure half of the exporter.
 *
 * Moved out of `../otel-exporter` (god-function burndown): splitting
 * `otelHttpExporter` in place would have pushed that file past the 1000-line
 * god-MODULE ceiling, and trading a god-function for a god-module is not a fix.
 * This block is the natural thing to move — it is PURE (a span or metric in, a
 * JSON body out), it has no reference to the exporter's batching or transport,
 * and it is where the protocol details live.
 *
 * The public types travel WITH it so there is no import cycle: `../otel-exporter`
 * re-exports them, keeping its published surface byte-identical.
 */

import { otlpAttributes } from "../otlp-attr-value"
import type { SpanKind, SpanStatusCode } from "../tracing/port"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "../vocabulary"

/** Attribute value the wire serializer accepts. Widens the port's scalar-only
 *  `SpanAttributes` to also carry the homogeneous arrays the `attrs.ts` builder
 *  already validates (`vocabulary.ts` `AttrValue`) — e.g.
 *  `gen_ai.response.finish_reasons` as a `string[]`. Scalars stay identical, so
 *  every existing producer of `SpanAttributes` remains assignable. */
export type SpanExportAttributes = Readonly<
  Record<
    string,
    | string
    | number
    | boolean
    | ReadonlyArray<string>
    | ReadonlyArray<number>
    | ReadonlyArray<boolean>
  >
>

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
  readonly attributes?: SpanExportAttributes
}

/** One metric observation ready for export. Counter / histogram / gauge map to
 *  OTLP `sum` / `histogram` / `gauge` respectively. */
export interface ExportMetric {
  readonly name: string
  readonly kind: "counter" | "histogram" | "gauge"
  readonly value: number
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
  readonly timeEpochMs: number
  /** UCUM unit for the OTLP metric descriptor (`unit` field). OMITTED ⇒ no
   *  `unit` key is serialized — byte-identical to the pre-T-C1 wire. Required
   *  for OTel-GenAI metrics (`s`, `{token}`); legacy metrics leave it unset. */
  readonly unit?: string
  /** Human-readable description for the OTLP metric descriptor (`description`
   *  field). OMITTED ⇒ no `description` key is serialized. */
  readonly description?: string
}

/** Map our SpanKind union to the OTLP enum integer (SPAN_KIND_UNSPECIFIED=0,
 *  INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5). The exhaustive
 *  switch + `never` fallthrough means a future addition to the union triggers
 *  a compile error here. */
export const otlpKind = (kind: SpanKind | undefined): number => {
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
export const otlpStatusCode = (code: SpanStatusCode | undefined): number => {
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

/** Convert epoch millis → string of unix nanos. OTLP requires nanos as a
 *  STRING to avoid 64-bit precision loss in JSON (per spec). We multiply once
 *  by 1e6 and convert to string.
 *
 *  TOTAL BY CONSTRUCTION. `start_time_unix_nano` / `end_time_unix_nano` are
 *  `fixed64`, so a non-finite or negative input must never reach the wire: the
 *  unguarded form emitted the literal tokens `"NaN"` / `"Infinity"`, which a
 *  spec-strict collector rejects for the WHOLE `resourceSpans` envelope — and
 *  `flushSpans` re-queues a rejected batch at the front of the buffer with no
 *  4xx classification, so one malformed span blackholes every later span for
 *  the life of the process. Degrading to `"0"` keeps the record exportable and
 *  visibly wrong instead of silently fatal. */
export const nanos = (epochMs: number): string =>
  Number.isFinite(epochMs) && epochMs >= 0 ? `${Math.trunc(epochMs * 1_000_000)}` : "0"

/** Resource attributes shared by every span/metric of one process. `quanta.run.id`
 *  is attached when the operator sets a run id (env `QUANTA_OTEL_RUN_ID`) so the
 *  trace-viewer can FILTER one bench run out of a sink that mixes many concurrent
 *  runs (e.g. an A/B fan-out) — the run-id deep-link (`?run=<id>`). Omitted (not
 *  empty-string) when unset, so Default-OFF stays byte-identical. */
export const buildResource = (serviceName: string, runId?: string): Record<string, unknown> => ({
  attributes: otlpAttributes({
    "service.name": serviceName,
    ...(runId !== undefined && runId !== "" ? { [QUANTA_ATTRS.run.id]: runId } : {}),
  }),
})

/** Read a span attribute as a plain string (the gen_ai discriminator attrs are
 *  always scalar strings). Returns undefined for absent / non-string values so
 *  the name mapper never stringifies an array/number into the span name. */
export const spanAttrString = (
  attrs: SpanExportAttributes | undefined,
  key: string,
): string | undefined => {
  const v = attrs?.[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/**
 * OTel-GenAI PINNED span name (`63f8200…`, gen-ai-spans.md). A gen_ai span's
 * name on the wire is `{gen_ai.operation.name} {subject}` where the subject is
 * the request model (chat), the tool name (execute_tool), or the agent name
 * (invoke_agent). We keep the INTERNAL Codex-style `SPAN_NAMES` id
 * (`run_sampling_request`) on the `ExportSpan` — the viewer joins on ids, not
 * names — and only re-map at THIS export boundary so every collector sees the
 * conformant name.
 *
 * Pure mapper over the span's own attributes:
 *   - No `gen_ai.operation.name` attr ⇒ NOT a gen_ai span; return the internal
 *     name verbatim (byte-identical for session_loop / turn / handle_tool_call…).
 *   - operation.name present + a subject attr (request.model / tool.name /
 *     agent.name, in that precedence) ⇒ `{operation} {subject}`.
 *   - operation.name present but NO subject attr ⇒ bare `{operation}` (the pin's
 *     fallback when the model/tool/agent is unavailable).
 */
export const otlpSpanName = (s: ExportSpan): string => {
  const operation = spanAttrString(s.attributes, GEN_AI_ATTRS.operation.name)
  if (operation === undefined) return s.name
  const subject =
    spanAttrString(s.attributes, GEN_AI_ATTRS.request.model) ??
    spanAttrString(s.attributes, GEN_AI_ATTRS.tool.name) ??
    spanAttrString(s.attributes, GEN_AI_ATTRS.agent.name)
  return subject !== undefined ? `${operation} ${subject}` : operation
}

/** Serialize an array of spans → OTLP/JSON `resourceSpans` envelope. */
export const serializeSpans = (
  spans: ReadonlyArray<ExportSpan>,
  serviceName: string,
  runId?: string,
): Record<string, unknown> => ({
  resourceSpans: [
    {
      resource: buildResource(serviceName, runId),
      scopeSpans: [
        {
          scope: { name: "quanta" },
          spans: spans.map((s) => {
            const out: Record<string, unknown> = {
              traceId: s.traceId,
              spanId: s.spanId,
              name: otlpSpanName(s),
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

/** OTLP `AggregationTemporality` enum. DELTA=1, CUMULATIVE=2. */
export const AGG_TEMPORALITY_DELTA = 1

/** Serialize an array of metrics → OTLP/JSON `resourceMetrics` envelope. Each
 *  metric is its own entry — we do NOT cross-aggregate samples with the same
 *  name in this exporter (the collector handles that). Counter → `sum`,
 *  histogram → `histogram` (single-point dataPoint), gauge → `gauge`.
 *
 *  ── TEMPORALITY (audit L9 M1) + START-TIME (audit L9 M2) ──────────────────
 *  This exporter ships each observation AS IT ARRIVES — every counter/histogram
 *  dataPoint is a SINGLE DELTA sample, not a running cumulative total. The
 *  pre-T09 code stamped these `aggregationTemporality: 2` (CUMULATIVE), which
 *  tells the collector "this value is the total since startTime". Two bugs
 *  followed:
 *    - M1: the collector double-counts (it diffs consecutive cumulatives, but
 *      our values are already deltas) — metric series come out inflated/wrong.
 *    - M2: a CUMULATIVE point whose `startTimeUnixNano === timeUnixNano` (which
 *      every first sample has, since we emit immediately) is REJECTED or
 *      zero-dropped by spec-strict collectors ("zero-length cumulative window").
 *  Emitting DELTA (1) fixes both: a delta point's window IS `[start, time]`
 *  with start==time meaning "this instant", which is valid, and the value is
 *  taken verbatim with no diffing. `isMonotonic` stays true for counters. */
export const serializeMetrics = (
  ms: ReadonlyArray<ExportMetric>,
  serviceName: string,
  runId?: string,
): Record<string, unknown> => ({
  resourceMetrics: [
    {
      resource: buildResource(serviceName, runId),
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
            // Descriptor-level fields (`unit`/`description`) — spread ONLY when
            // declared so a metric without them serializes byte-identical to
            // the pre-T-C1 wire (no `unit`/`description` key appears). OTLP puts
            // both at the metric object level, alongside `name` + the
            // sum/histogram/gauge data. (audit T-C1)
            const descriptor: Record<string, string> = {
              name: m.name,
              ...(m.unit !== undefined ? { unit: m.unit } : {}),
              ...(m.description !== undefined ? { description: m.description } : {}),
            }
            if (m.kind === "counter") {
              return {
                ...descriptor,
                sum: {
                  dataPoints: [dp],
                  aggregationTemporality: AGG_TEMPORALITY_DELTA,
                  isMonotonic: true,
                },
              }
            }
            if (m.kind === "histogram") {
              return {
                ...descriptor,
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
                  aggregationTemporality: AGG_TEMPORALITY_DELTA,
                },
              }
            }
            // gauge — a gauge has NO temporality (it's a point-in-time value).
            return {
              ...descriptor,
              gauge: { dataPoints: [dp] },
            }
          }),
        },
      ],
    },
  ],
})

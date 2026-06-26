#!/usr/bin/env bun
/**
 * otel-trace-sink — a tiny standalone OTLP/JSON receiver for the LIVE bench trace
 * view (ADR-0268, jun-26 full-remote live trace).
 *
 * The bench agent loop's OTLP exporter (`src/observability/otel-exporter.ts`) POSTs
 * OTLP/JSON envelopes to `<QUANTA_OTEL_ENDPOINT>/v1/traces` and `/v1/metrics`. This
 * script is the operator-side terminal receiver: a bun HTTP server that accepts
 * those POSTs and prints each span ONE LINE live, so the operator watches the
 * agent's activity (LLM requests, tool calls, reasoning, durations) stream from a
 * full-remote box in real time — instead of waiting on the flaky box→local run.log
 * push.
 *
 * Usage
 * -----
 *   bun tools/otel-trace-sink.ts                 # listen on 0.0.0.0:4318
 *   PORT=4319 bun tools/otel-trace-sink.ts       # custom port
 *   bun tools/otel-trace-sink.ts --metrics       # also print metric data points
 *
 * Then point the bench at it:
 *   QUANTA_OTEL_ENDPOINT=http://127.0.0.1:4318 quanta-bench run --swebench …
 *
 * For a full-remote box, reverse-tunnel the port to the box (like the oauth proxy)
 * and forward QUANTA_OTEL_ENDPOINT pointing at the box-local tunnel address — the
 * box's bench process attaches the exporter (FORWARD_EXTRA_ENV in box-session.ts)
 * and ships spans back through the tunnel.
 *
 * The JSON shape parsed here MIRRORS exactly what `otel-exporter.ts` serializes
 * (`serializeSpans`/`serializeMetrics`): `resourceSpans[].scopeSpans[].spans[]`
 * with string-nanos timestamps and OTLP tagged attribute values. NO OTel SDK dep —
 * the wire contract is the OTLP spec.
 *
 * Default port 4318 = the OTLP/HTTP convention.
 */

const DEFAULT_PORT = 4318

// ── OTLP/JSON wire shapes (the subset otel-exporter.ts emits) ────────────────
// Attribute values are tagged unions: stringValue / intValue / doubleValue /
// boolValue. We extract the present tag.
interface OtlpAnyValue {
  readonly stringValue?: string
  readonly intValue?: number | string
  readonly doubleValue?: number
  readonly boolValue?: boolean
}
interface OtlpKeyValue {
  readonly key?: string
  readonly value?: OtlpAnyValue
}
interface OtlpSpan {
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly name?: string
  readonly kind?: number
  readonly startTimeUnixNano?: string
  readonly endTimeUnixNano?: string
  readonly attributes?: ReadonlyArray<OtlpKeyValue>
  readonly status?: { readonly code?: number; readonly message?: string }
}
interface OtlpResourceSpans {
  readonly resourceSpans?: ReadonlyArray<{
    readonly resource?: { readonly attributes?: ReadonlyArray<OtlpKeyValue> }
    readonly scopeSpans?: ReadonlyArray<{ readonly spans?: ReadonlyArray<OtlpSpan> }>
  }>
}
interface OtlpMetric {
  readonly name?: string
  readonly sum?: { readonly dataPoints?: ReadonlyArray<OtlpDataPoint> }
  readonly gauge?: { readonly dataPoints?: ReadonlyArray<OtlpDataPoint> }
  readonly histogram?: { readonly dataPoints?: ReadonlyArray<OtlpDataPoint> }
}
interface OtlpDataPoint {
  readonly asDouble?: number
  readonly sum?: number
  readonly attributes?: ReadonlyArray<OtlpKeyValue>
}
interface OtlpResourceMetrics {
  readonly resourceMetrics?: ReadonlyArray<{
    readonly scopeMetrics?: ReadonlyArray<{ readonly metrics?: ReadonlyArray<OtlpMetric> }>
  }>
}

/** Extract the scalar from an OTLP tagged value. */
const valueOf = (v: OtlpAnyValue | undefined): string | number | boolean | undefined => {
  if (v === undefined) return undefined
  if (v.stringValue !== undefined) return v.stringValue
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue
  if (v.boolValue !== undefined) return v.boolValue
  return undefined
}

/** Flatten an OTLP KeyValue list → a plain record. */
const attrsOf = (
  kvs: ReadonlyArray<OtlpKeyValue> | undefined,
): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}
  if (kvs === undefined) return out
  for (const kv of kvs) {
    if (kv.key === undefined) continue
    const v = valueOf(kv.value)
    if (v !== undefined) out[kv.key] = v
  }
  return out
}

/** OTLP SpanKind enum → short label (1=INTERNAL,2=SERVER,3=CLIENT,4=PRODUCER,5=CONSUMER). */
const kindLabel = (k: number | undefined): string =>
  ({ 1: "internal", 2: "server", 3: "client", 4: "producer", 5: "consumer" })[k ?? 1] ?? "internal"

/** OTLP StatusCode → label (0=unset,1=ok,2=error). */
const statusLabel = (c: number | undefined): string =>
  ({ 0: "unset", 1: "ok", 2: "error" })[c ?? 0] ?? "unset"

/** Compute duration ms from string-nanos start/end. */
const durMs = (startNano: string | undefined, endNano: string | undefined): number | undefined => {
  if (startNano === undefined || endNano === undefined) return undefined
  const s = Number(startNano)
  const e = Number(endNano)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return undefined
  return Math.round((e - s) / 1_000_000)
}

/** The attribute keys most worth surfacing inline, in priority order. The
 *  exporter ships the loop's vocabulary (`gen_ai.*`, `quanta.tool.*`,
 *  `quanta.instance.*`, etc.); we render the highest-signal ones. */
const KEY_ATTRS: ReadonlyArray<string> = [
  "quanta.instance.id",
  "instance",
  "quanta.tool.name",
  "tool",
  "quanta.tool.call.status",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.response.finish_reasons",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "quanta.turn.id",
  "quanta.turn.kind",
]

/** Render the projected single-line view of ONE span. Exported for unit test. */
export interface ParsedSpan {
  readonly name: string
  readonly durationMs: number | undefined
  readonly kind: string
  readonly status: string
  readonly attrs: Record<string, string | number | boolean>
}

/** Parse an OTLP/JSON `resourceSpans` envelope → flat ParsedSpan[]. Exported so
 *  a unit test can post the exact shape otel-exporter emits and assert the
 *  name/duration/attrs extraction. NEVER throws on a malformed sub-tree —
 *  missing arms are simply skipped (a live receiver must not crash on a partial
 *  batch). */
export const parseResourceSpans = (body: OtlpResourceSpans): ParsedSpan[] => {
  const out: ParsedSpan[] = []
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        out.push({
          name: span.name ?? "(unnamed)",
          durationMs: durMs(span.startTimeUnixNano, span.endTimeUnixNano),
          kind: kindLabel(span.kind),
          status: statusLabel(span.status?.code),
          attrs: attrsOf(span.attributes),
        })
      }
    }
  }
  return out
}

/** Parse an OTLP/JSON `resourceMetrics` envelope → flat [name, value, attrs][].
 *  Exported for the unit test. */
export interface ParsedMetric {
  readonly name: string
  readonly value: number | undefined
  readonly attrs: Record<string, string | number | boolean>
}
export const parseResourceMetrics = (body: OtlpResourceMetrics): ParsedMetric[] => {
  const out: ParsedMetric[] = []
  for (const rm of body.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const dps = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? []
        for (const dp of dps) {
          out.push({
            name: m.name ?? "(unnamed)",
            value: dp.asDouble ?? dp.sum,
            attrs: attrsOf(dp.attributes),
          })
        }
      }
    }
  }
  return out
}

/** Build the one-line render of a parsed span: `name | dur | key attrs`. */
export const formatSpanLine = (s: ParsedSpan): string => {
  const dur = s.durationMs !== undefined ? `${s.durationMs}ms` : "—"
  const keyParts: string[] = []
  for (const k of KEY_ATTRS) {
    if (k in s.attrs) keyParts.push(`${k}=${s.attrs[k]}`)
  }
  const statusMark = s.status === "error" ? " ✗" : s.status === "ok" ? "" : ` [${s.status}]`
  const tail = keyParts.length > 0 ? ` | ${keyParts.join(" ")}` : ""
  return `${s.name.padEnd(22)} | ${dur.padStart(8)}${statusMark}${tail}`
}

export const formatMetricLine = (m: ParsedMetric): string => {
  const keyParts = Object.keys(m.attrs).map((k) => `${k}=${m.attrs[k]}`)
  const tail = keyParts.length > 0 ? ` {${keyParts.join(" ")}}` : ""
  return `metric ${m.name} = ${m.value ?? "?"}${tail}`
}

// ── HTTP server (only when run directly) ─────────────────────────────────────
const runServer = (): void => {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const showMetrics = process.argv.includes("--metrics")
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "POST") {
        return new Response("otel-trace-sink: POST OTLP/JSON to /v1/traces or /v1/metrics\n", {
          status: 200,
        })
      }
      let parsed: unknown
      try {
        parsed = await req.json()
      } catch {
        return new Response('{"partialSuccess":{}}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      try {
        if (url.pathname === "/v1/traces") {
          for (const s of parseResourceSpans(parsed as OtlpResourceSpans)) write(formatSpanLine(s))
        } else if (url.pathname === "/v1/metrics" && showMetrics) {
          for (const m of parseResourceMetrics(parsed as OtlpResourceMetrics))
            write(formatMetricLine(m))
        }
      } catch (e) {
        write(`[otel-trace-sink] parse error: ${(e as Error).message}`)
      }
      // OTLP/HTTP success envelope (empty partialSuccess = fully accepted).
      return new Response('{"partialSuccess":{}}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  write(
    `otel-trace-sink listening on http://0.0.0.0:${port} — POST OTLP/JSON to /v1/traces${
      showMetrics ? " (+/v1/metrics)" : ""
    }`,
  )
}

if (import.meta.main) runServer()

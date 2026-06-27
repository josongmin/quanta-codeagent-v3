#!/usr/bin/env bun
/**
 * otel-trace-sink — a standalone OTLP/JSON receiver + live waterfall UI for the
 * bench trace view (ADR-0268, jun-26 full-remote live trace; jun-27 waterfall UI).
 *
 * The bench agent loop's OTLP exporter (`src/observability/otel-exporter.ts`) POSTs
 * OTLP/JSON envelopes to `<QUANTA_OTEL_ENDPOINT>/v1/traces` and `/v1/metrics`. This
 * receiver accepts those POSTs, prints each span ONE LINE live, AND serves a
 * browser waterfall (`trace-viewer.html`, co-located) at `GET /` backed by
 * `GET /spans.json` — so the operator watches the agent's activity (LLM requests,
 * tool calls, durations, prompt/response payloads) stream in real time.
 *
 * Usage
 * -----
 *   quanta-bench trace                           # CLI wrapper (launch + open browser)
 *   bun src/apps/bench/otel-trace-sink.ts        # run directly; listen on 0.0.0.0:4318
 *   PORT=4319 bun src/apps/bench/otel-trace-sink.ts   # custom port
 *   QUANTA_OTEL_SAVE=spans.jsonl bun src/apps/bench/otel-trace-sink.ts        # tee → local file
 *   QUANTA_OTEL_SINK=s3://bucket/traces/run1 bun src/apps/bench/otel-trace-sink.ts  # tee → S3
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

import {
  fileSpanSink,
  noopSpanSink,
  resolveSpanSink,
  type SpanSinkPort,
} from "./span-sink"
import { errMessage } from "@/shared"

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
const readScalar = (v: OtlpAnyValue | undefined): string | number | boolean | undefined => {
  if (v === undefined) return undefined
  if (v.stringValue !== undefined) return v.stringValue
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.intValue !== undefined)
    return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue
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
    const v = readScalar(kv.value)
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

/** A structurally-complete span for the waterfall UI — keeps the ids and
 *  nanosecond timestamps that `ParsedSpan` flattens away. `start`/`end` are
 *  numbers (epoch nanos) so the browser can lay out a timeline. Exported for the
 *  unit test. */
export interface FullSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string
  readonly name: string
  readonly kind: string
  readonly startNano: number
  readonly endNano: number
  readonly durationMs: number | undefined
  readonly status: string
  readonly attrs: Record<string, string | number | boolean>
}

/** Parse an OTLP/JSON `resourceSpans` envelope → FullSpan[] preserving trace/span
 *  ids and timestamps (for the waterfall). Same never-throw contract as
 *  parseResourceSpans. */
export const parseResourceSpansFull = (body: OtlpResourceSpans): FullSpan[] => {
  const out: FullSpan[] = []
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        out.push({
          traceId: span.traceId ?? "",
          spanId: span.spanId ?? "",
          parentSpanId: span.parentSpanId ?? "",
          name: span.name ?? "(unnamed)",
          kind: kindLabel(span.kind),
          startNano: Number(span.startTimeUnixNano ?? 0),
          endNano: Number(span.endTimeUnixNano ?? 0),
          durationMs: durMs(span.startTimeUnixNano, span.endTimeUnixNano),
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

// ── HTTP server ──────────────────────────────────────────────────────────────
/** OTLP/HTTP success envelope (empty partialSuccess = fully accepted). */
const okEnvelope = (): Response =>
  new Response('{"partialSuccess":{}}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

/** GET routing → the waterfall UI (`/`, `/ui`) + its data feed (`/spans.json`).
 *  Module-level so `runTraceSink` stays a thin wiring function. */
const handleGet = (url: URL, collected: ReadonlyArray<FullSpan>, uiHtml: Blob): Response => {
  if (url.pathname === "/spans.json") {
    return new Response(JSON.stringify(collected), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    })
  }
  if (url.pathname === "/" || url.pathname === "/ui") {
    return new Response(uiHtml, { headers: { "Content-Type": "text/html" } })
  }
  return new Response("otel-trace-sink: GET / (waterfall UI) · POST OTLP/JSON to /v1/traces\n", {
    status: 200,
  })
}

/** Ingest a `/v1/traces` batch: print one line per span AND collect the
 *  structured spans (ring-capped at `ringMax`) for the UI, tee'd to the durable
 *  {@link SpanSinkPort} (file / S3 / noop). Mutates `collected` in place. */
const ingestTraces = (
  parsed: unknown,
  collected: FullSpan[],
  ringMax: number,
  spanSink: SpanSinkPort,
  write: (line: string) => void,
): void => {
  for (const s of parseResourceSpans(parsed as OtlpResourceSpans)) write(formatSpanLine(s))
  for (const s of parseResourceSpansFull(parsed as OtlpResourceSpans)) {
    collected.push(s)
    // Durable tee is best-effort BY CONTRACT (the adapter swallows its own disk /
    // S3 errors) — a dropped span must never break the live ring + UI.
    spanSink.write(JSON.stringify(s))
  }
  if (collected.length > ringMax) collected.splice(0, collected.length - ringMax)
}

/** Options for {@link runTraceSink}. All optional — each falls back to the env
 *  var / argv it historically read, so `runTraceSink()` is unchanged behavior
 *  and `quanta-bench trace --port N --save f` (the CLI wiring) can pass them in. */
export interface TraceSinkOptions {
  readonly port?: number
  readonly showMetrics?: boolean
  /** @deprecated prefer {@link spanSink}. Back-compat: a bare path ⇒ fileSpanSink. */
  readonly savePath?: string
  /** Durable persistence target (file / S3 / noop). Default noop = ring only.
   *  Resolve from env with {@link resolveSpanSink}; the caller owns env reading. */
  readonly spanSink?: SpanSinkPort
  /** Human label for the resolved sink, shown in the listening banner. */
  readonly sinkLabel?: string
  /** Max structured spans retained for the UI feed. Default 5000. */
  readonly ringMax?: number
}

/** Start the OTLP/JSON receiver + live waterfall UI. PURE w.r.t. the
 *  environment — every knob arrives via {@link TraceSinkOptions}, so the caller
 *  (the CLI sub-command or the script entry point) owns all `process.env`
 *  resolution. Exported so the bench CLI (`quanta-bench trace`) can launch it
 *  in-process. Returns the resolved port + UI URL. */
export const runTraceSink = (opts: TraceSinkOptions = {}): { port: number; uiUrl: string } => {
  const port = opts.port ?? DEFAULT_PORT
  const showMetrics = opts.showMetrics ?? false
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  // In-memory ring of structured spans for the waterfall UI (GET /spans.json).
  // Capped so a long live run can't grow it unbounded; the browser only ever
  // needs a recent window. `savePath` optionally tees each span to a .jsonl for
  // later offline replay into the same viewer.
  const RING_MAX = opts.ringMax ?? 5000
  const collected: FullSpan[] = []
  // Durable tee: explicit port wins, else back-compat a bare savePath ⇒ file, else
  // noop (ring only). The S3/file ADAPTER owns its own errors (best-effort).
  const spanSink =
    opts.spanSink ?? (opts.savePath !== undefined ? fileSpanSink(opts.savePath) : noopSpanSink())
  // Periodically flush a partial buffer so an S3 batch < flushEveryN doesn't sit
  // unuploaded between bursts (no-op for file/noop). The receiver runs forever, so
  // there is no shutdown hook to flush on — this bounds the unflushed window.
  setInterval(() => {
    void spanSink.flush()
  }, 15_000)
  const uiHtml = Bun.file(`${import.meta.dir}/trace-viewer.html`)

  // Route a parsed POST body to traces/metrics ingestion. Never throws — a
  // malformed sub-tree is logged, not fatal (a live receiver must survive a
  // partial batch). Extracted to keep `fetch` under the complexity cap.
  const routePost = (url: URL, parsed: unknown): void => {
    try {
      if (url.pathname === "/v1/traces") ingestTraces(parsed, collected, RING_MAX, spanSink, write)
      else if (url.pathname === "/v1/metrics" && showMetrics) {
        for (const m of parseResourceMetrics(parsed as OtlpResourceMetrics))
          write(formatMetricLine(m))
      }
    } catch (e) {
      write(`[otel-trace-sink] parse error: ${errMessage(e)}`)
    }
  }

  Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET") return handleGet(url, collected, uiHtml)
      if (req.method !== "POST") {
        return new Response("otel-trace-sink: POST OTLP/JSON to /v1/traces or /v1/metrics\n", {
          status: 200,
        })
      }
      let parsed: unknown
      try {
        parsed = await req.json()
      } catch {
        return okEnvelope()
      }
      routePost(url, parsed)
      return okEnvelope()
    },
  })
  const uiUrl = `http://127.0.0.1:${port}/`
  write(
    `otel-trace-sink listening on http://0.0.0.0:${port} — waterfall UI at ${uiUrl} · POST OTLP/JSON to /v1/traces${
      showMetrics ? " (+/v1/metrics)" : ""
    }${opts.sinkLabel !== undefined ? ` · durable → ${opts.sinkLabel}` : ""}`,
  )
  return { port, uiUrl }
}

// ── Script entry point ───────────────────────────────────────────────────────
// The ONLY env-reading site: resolve operator knobs from process.env/argv and
// hand fully-validated options to the pure `runTraceSink`. A NaN-guarded parse
// keeps garbage (`PORT=abc`) from silently disabling the cap (vs raw `Number`).
const envInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

if (import.meta.main) {
  // `ringMax` is intentionally NOT env-driven — it is a niche in-memory cap with a
  // sane default; programmatic callers override via opts. Keeping it off `process.env`
  // avoids a registry-orphan operator knob for a value nobody tunes from the shell.
  const sinkDest =
    process.env.QUANTA_OTEL_SINK ??
    (process.env.QUANTA_OTEL_SAVE !== undefined && process.env.QUANTA_OTEL_SAVE !== ""
      ? `file:${process.env.QUANTA_OTEL_SAVE}`
      : undefined)
  runTraceSink({
    port: envInt(process.env.PORT, DEFAULT_PORT),
    showMetrics: process.argv.includes("--metrics"),
    spanSink: resolveSpanSink(process.env),
    ...(sinkDest !== undefined ? { sinkLabel: sinkDest } : {}),
  })
}

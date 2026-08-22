/**
 * Observability metrics — typed port (ADR-0144).
 *
 * Closed-port primitive for first-class metrics: counter / histogram / gauge
 * with an injected sink so callers can pipe samples to OTel, Prometheus, JSONL,
 * or stderr without coupling the domain to a transport.
 *
 * SOTA reference: every modern agent emits unstructured logs (Cursor IDE panel,
 * Claude Code session totals, Codex per-model OTel breakdown) but none expose a
 * typed `MetricSink` + `MetricsRegistry` pair that lets the operator query
 * `tool_calls_total` / `turn_duration_ms` / `verify_gate_pass_total` in-process
 * AND export to an out-of-process collector. quanta has a rich `AgentEvent`
 * trace stream (ADR-0035 jsonl recorder) but no metrics primitive — this slice
 * fills that gap.
 *
 * Plane-clean: this module imports ONLY `@/shared` (for the QuantaError base).
 * No `@/agent`, `@/llm`, `@/permission`, `@/tool` — those are future consumers,
 * never collaborators of this primitive.
 *
 * Default-OFF: nothing in the loop instantiates a registry today. Surfaces
 * (`apps/agent` bootstrap, future dispatch.ts auto-instrument, future verify
 * gate counters) opt in by constructing `defaultMetricsRegistry()` and wiring
 * either a built-in sink (`consoleMetricsSink`, `jsonlMetricsSink`) or a custom
 * OTel/Prometheus adapter. With NO sink set, `send` is never called — the
 * registry stays a pure in-process snapshot source for `/metrics` panels.
 */

import { QuantaError } from "@/shared"

/** Closed 3-arm union — adding a 4th metric kind requires an ADR amendment and
 *  a compile-error update at every exhaustive switch site. */
export type MetricKind = "counter" | "histogram" | "gauge"

/**
 * Typed instrument descriptor — the SSOT for a metric's wire metadata
 * (ADR-0539 / T-C1). An emitter declares `{name, kind, unit, description}`
 * ONCE and every sample it produces carries that metadata to the OTLP wire.
 *
 * OTel-GenAI conformance REQUIRES a `unit` on every metric (`s` for durations,
 * `{token}` for token usage) — a bare name+number is non-conformant. This
 * descriptor lets an emitter attach the UCUM unit + a human `description` at
 * the declaration site so the OTLP metric descriptor object carries them.
 *
 * `unit`/`description` are OPTIONAL: an instrument that declares neither
 * serializes EXACTLY as before (no `unit`/`description` key on the wire) — so
 * every pre-existing metric stays byte-identical. Declaring a `unit` is purely
 * additive.
 */
export interface InstrumentDescriptor {
  readonly name: string
  readonly kind: MetricKind
  /** UCUM unit string (OTLP metric `unit` field). E.g. `"s"`, `"ms"`,
   *  `"{token}"`, `"By"`. OMITTED ⇒ no `unit` key on the OTLP metric
   *  (byte-identical to the pre-descriptor wire). */
  readonly unit?: string
  /** Human-readable metric description (OTLP metric `description` field).
   *  OMITTED ⇒ no `description` key on the wire. */
  readonly description?: string
}

/** One observation handed to a `MetricSink`. Immutable on the wire. */
export interface MetricSample {
  readonly name: string
  readonly kind: MetricKind
  /** Counter delta / histogram observation / gauge value (depends on kind). */
  readonly value: number
  /** Optional label set. Combines with `name` to form the unique time-series.
   *  Omitted when no labels were supplied (exactOptionalPropertyTypes). */
  readonly labels?: Readonly<Record<string, string>>
  /** Epoch ms when the sample was recorded (registry-supplied clock). */
  readonly at: number
  /** Optional UCUM unit (OTLP metric `unit` field) — see `InstrumentDescriptor`.
   *  OMITTED ⇒ the OTLP metric carries NO `unit` key (byte-identical to the
   *  pre-descriptor wire). OTel-GenAI metrics REQUIRE this (`s`, `{token}`);
   *  legacy metrics leave it unset and are unchanged. */
  readonly unit?: string
  /** Optional human-readable description (OTLP metric `description` field).
   *  OMITTED ⇒ no `description` key on the wire. */
  readonly description?: string
}

/** Sink adapter. Implementations MUST NOT throw — the registry catches
 *  defensively, but a no-throw policy at the implementor lets callers
 *  reason about recording cost without try/catch noise. */
export interface MetricSink {
  /** Receive a metric sample. No-throw — sink failure must not block
   *  recording. Implementations should defer/buffer if downstream I/O is
   *  slow; the registry calls `send` synchronously for every observation. */
  send(sample: MetricSample): void
  /** Optional batch flush. The registry calls this from its own `flush()` if
   *  present, so a buffered sink (jsonlMetricsSink, an OTel batch adapter)
   *  can drain on shutdown. Absent ⇒ the registry treats flush as a no-op. */
  flush?(): Promise<void>
}

/** Public registry surface. */
export interface MetricsRegistry {
  /** Increment a counter by `delta` (default 1). Labels combine with `name`
   *  to form the unique time-series. Counters monotonically increase — they
   *  never go down. Negative / non-finite `delta` is silently coerced to 0
   *  (a poisoned caller value cannot poison the registry). */
  increment(name: string, delta?: number, labels?: Record<string, string>): void
  /** Record a histogram observation. Non-finite `value` silently coerced to
   *  0. The default in-memory adapter keeps exact observations only up to a
   *  bounded cap, then compacts percentile state so long-lived processes keep
   *  exact count/sum without unbounded histogram memory growth. */
  observe(name: string, value: number, labels?: Record<string, string>): void
  /** Set a gauge to `value`. Latest-write-wins per (name, labels). Non-finite
   *  `value` silently coerced to 0. */
  gauge(name: string, value: number, labels?: Record<string, string>): void
  /** Read-only snapshot for in-process queries (the eventual `/metrics`
   *  endpoint, the cost panel, an admin slash command). Always returns a
   *  fresh array — callers may sort / filter without affecting state. */
  snapshot(): ReadonlyArray<MetricSnapshot>
  /** Reset all metrics (counters, histograms, gauges). Does NOT call
   *  `sink.flush()` — the caller chooses whether to drain first. */
  reset(): void
  /** Optional batch flush. Delegates to `sink.flush()` when wired and present;
   *  resolves immediately when no sink is configured. */
  flush(): Promise<void>
}

/** One row of a snapshot. Per-series shape — counters and gauges fill only
 *  the totals, histograms add `count` + percentiles. */
export interface MetricSnapshot {
  readonly name: string
  readonly kind: MetricKind
  readonly labels: Readonly<Record<string, string>>
  /** Counter: monotonic total. Gauge: current value. Histogram: sum of
   *  observations. (One numeric field keeps the row friendly to OTel /
   *  Prometheus exporters that all model these the same way.) */
  readonly value: number
  /** Histogram observation count. OMITTED for counter / gauge
   *  (exactOptionalPropertyTypes). */
  readonly count?: number
  /** Histogram p50 / p95 / p99. OMITTED for counter / gauge. */
  readonly p50?: number
  readonly p95?: number
  readonly p99?: number
}

/** Closed 2-arm error code union. */
export type MetricsErrorCode = "name-mismatch-kind" | "sink-failed"

/** Throwing surface. The registry only throws `name-mismatch-kind` (a
 *  programmer bug — same name was used for two different kinds). Sink
 *  failures are caught + suppressed (`sink-failed` is reserved for future
 *  call sites that propagate failure deliberately, e.g. a strict-mode flag). */
export class MetricsError extends QuantaError {
  readonly errorCode: MetricsErrorCode
  constructor(code: MetricsErrorCode, message: string) {
    super(`metrics:${code}`, message)
    this.errorCode = code
  }
}

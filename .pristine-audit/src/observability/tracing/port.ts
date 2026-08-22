/**
 * Distributed tracing — typed port (ADR-0186).
 *
 * Closed-port primitive for span-based causality. Where metrics (ADR-0144)
 * count and aggregate, traces record the parent/child tree of operations:
 * every tool call is a span, every LLM stream is a span, every subagent fork
 * is a span linked into its parent's trace. Spans nest so a 30s agent loop
 * decomposes into "10s LLM stream + 15s bash + 5s verify-guard" without grep
 * + jq + post-hoc reconstruction.
 *
 * SOTA reference:
 *   - W3C Trace Context (https://www.w3.org/TR/trace-context/) — the
 *     canonical wire format for `traceparent` / `tracestate` headers across
 *     process boundaries. Every modern collector (Jaeger, Tempo, Honeycomb,
 *     Datadog, X-Ray) speaks it.
 *   - OpenTelemetry SDK — the canonical in-process API for building span
 *     trees and shipping them to exporters. We adapt rather than re-export
 *     so the port stays the contract our domain depends on; OTel is one
 *     adapter behind it.
 *
 * Plane-clean: this module imports NOTHING from `@/agent`, `@/tool`, `@/llm`,
 * `@/permission`, `@/runtime`, etc. Tracing is the bottom of the observation
 * stack — future consumers wire it from above (dispatch instrument, LLM
 * stream wrap, subagent fork-link), never from inside the primitive.
 *
 * Default-OFF: the barrel exports `defaultTracer = noopTracer`. With NO OTel
 * adapter wired, every `startSpan` / `withSpan` returns a no-op span — byte-
 * identical to "no tracing wired" so surfaces that don't opt in pay zero
 * observability cost. Surfaces opt in by constructing `otelTracer({…})` with
 * a caller-owned `TracerProvider` (the SDK lifecycle — exporter, resource,
 * shutdown — stays with the caller).
 */

/** Closed 5-arm union matching W3C / OTel span kinds verbatim. Adding a 6th
 *  requires an ADR amendment and a compile-error update at every exhaustive
 *  switch site. */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer"

/** Span lifecycle status. Defaults to `"unset"` until the caller chooses. */
export type SpanStatusCode = "unset" | "ok" | "error"

/** The portion of a span that crosses process boundaries (W3C `traceparent`).
 *  Immutable on the wire — every field is a stable identifier the recipient
 *  uses to bind incoming work to an existing trace. */
export interface SpanContext {
  /** 32-hex lowercase trace ID (128 bits). */
  readonly traceId: string
  /** 16-hex lowercase span ID (64 bits). */
  readonly spanId: string
  /** W3C trace flags. Bit 0 = sampled (1) / not sampled (0). Other bits
   *  reserved per the spec. */
  readonly traceFlags: number
}

/** Closed-union attribute value. We deliberately do NOT allow `string[]` or
 *  `number[]` (which OTel allows) — exotic value shapes invite cardinality
 *  explosion and surface most of OTel's adapter-mapping ceremony for almost
 *  zero gain on our scales. If a caller needs an array, they join it client-
 *  side first. */
export interface SpanAttributes {
  readonly [key: string]: string | number | boolean
}

/** A live span. Mutation methods are no-throw (an observability primitive
 *  must never crash its caller). `end()` is idempotent — calling it twice is
 *  a no-op even on an OTel-backed span (we guard in the adapter). */
export interface Span {
  /** Immutable identity. Stable for the span's entire lifetime — child spans
   *  derive their context from this. */
  readonly context: SpanContext
  /** Set one attribute. Overwrites prior value for the same key. */
  setAttribute(key: string, value: string | number | boolean): void
  /** Set the span lifecycle status. Per W3C, `ok` is a deliberate signal
   *  (auto-completion does NOT default to `ok`) and `error` carries an
   *  optional human message. */
  setStatus(code: SpanStatusCode, message?: string): void
  /** Record an exception as a span event (per OTel `exception.{type,message,
   *  stacktrace}` convention). Does NOT change status — callers choose
   *  whether to also set `error`. */
  recordException(error: Error): void
  /** Mark span end. `endTime` is epoch ms; default is `Date.now()` at call
   *  time. Idempotent — second call is a no-op. */
  end(endTime?: number): void
}

/** Construct a span. Both methods are no-throw: even when OTel misbehaves
 *  (provider down, exporter rejecting, network partition), callers see a
 *  valid `Span` they can call `.end()` on without try/catch noise. */
export interface Tracer {
  /** Start a new span. When `opts.parent` is provided (as either a `Span` or
   *  a raw `SpanContext`), the new span is its child — the trace ID is
   *  inherited, only the span ID is fresh. When absent, a new root trace is
   *  started.
   *
   *  No-throw on observability failure: misbehaving providers return a no-op
   *  span (the caller's code path is unaffected). */
  startSpan(
    name: string,
    opts?: {
      readonly kind?: SpanKind
      readonly parent?: SpanContext | Span
      readonly attributes?: SpanAttributes
      /** Epoch ms. Default = current time at call. */
      readonly startTime?: number
    },
  ): Span
  /** Run `fn` inside a span — auto-ends on resolve OR reject; auto-status
   *  (`ok` on resolve, `error` + `recordException` on reject). Re-throws the
   *  original rejection so the caller's control flow is unchanged. */
  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    opts?: Parameters<Tracer["startSpan"]>[1],
  ): Promise<T>
}

/** W3C Trace Context propagation. `inject` writes the `traceparent` (and
 *  `tracestate` when present) into a carrier (HTTP headers, JSON envelope,
 *  message metadata). `extract` parses them back to a `SpanContext`.
 *
 *  Cross-process trace continuity is THE point of W3C Trace Context — the
 *  receiving process calls `startSpan(name, {parent: extract(headers)})` to
 *  bind its work to the sender's trace tree. */
export interface TraceContextPropagator {
  /** Inject the `traceparent` header into `carrier`. Per W3C the value is
   *  `00-${traceId}-${spanId}-${flags.toString(16).padStart(2,"0")}`. */
  inject(ctx: SpanContext, carrier: Record<string, string>): void
  /** Parse `traceparent` from `carrier`. Returns `null` when missing, when
   *  shape mismatches (wrong segment count, wrong widths, non-hex chars,
   *  unsupported version), or when the trace/span ID is all-zero (W3C
   *  reserves the all-zero ID for "invalid"). */
  extract(carrier: Record<string, string>): SpanContext | null
}

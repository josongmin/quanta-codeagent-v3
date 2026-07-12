/**
 * Distributed tracing barrel (ADR-0186).
 *
 * Re-exports the typed `Tracer` port + no-op adapter (default) + OTel adapter
 * + W3C propagator. Surfaces import from `@/observability/tracing`; the parent
 * `@/observability` barrel intentionally does NOT pull this in (Default-OFF
 * — surfaces opt in by importing the sub-barrel explicitly, same posture as
 * `@/observability/metrics` per ADR-0144).
 *
 * `defaultTracer = noopTracer` so callers that don't wire OTel get a working,
 * zero-cost no-op. Upgrading is a single line:
 *
 *   import { otelTracer } from "@/observability/tracing"
 *   const tracer = otelTracer({ tracerProvider: myProvider })
 */

export { getActiveTraceRef, runWithActiveTraceRef, type TraceRef } from "./active-context"
// Default export is the no-op tracer — surfaces opt in to OTel explicitly.
export { contextTracer, noopTracer, noopTracer as defaultTracer } from "./noop-tracer"
export { mapKind, type OtelTracerOpts, otelTracer } from "./otel-tracer"
export type {
  Span,
  SpanAttributes,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  TraceContextPropagator,
  Tracer,
} from "./port"
export { w3cTraceContextPropagator } from "./w3c-propagator"

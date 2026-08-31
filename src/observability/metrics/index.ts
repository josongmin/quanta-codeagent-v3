/**
 * Observability metrics barrel (ADR-0144).
 *
 * Re-exports the typed registry port + in-memory adapter + 2 built-in sinks.
 * Surfaces import from `@/observability/metrics`; the parent
 * `@/observability` barrel intentionally does NOT pull this in (Default-OFF —
 * surfaces opt-in by importing the sub-barrel explicitly).
 */

export { consoleMetricsSink } from "./console-sink"
export {
  createDecisionCounterSink,
  type DecisionCounterSinkOpts,
} from "./decision-counter-sink"
export { defaultMetricsRegistry, type InMemoryRegistryOpts } from "./in-memory-registry"
export { jsonlMetricsSink } from "./jsonl-sink"
export {
  createObjectiveLifecycleMetricsSink,
  OBJECTIVE_LIFECYCLE_COUNTER,
  type ObjectiveLifecycleMetricSink,
} from "./objective-lifecycle"
export {
  type OtelAttributes,
  type OtelCounter,
  type OtelHistogram,
  type OtelMeter,
  type OtelMeterProvider,
  type OtelSinkOpts,
  type OtelUpDownCounter,
  otelMetricsSink,
} from "./otel-sink"
export {
  type MetricKind,
  type MetricSample,
  type MetricSink,
  type MetricSnapshot,
  MetricsError,
  type MetricsErrorCode,
  type MetricsRegistry,
} from "./port"

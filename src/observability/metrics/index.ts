/**
 * Observability metrics barrel (ADR-0144).
 *
 * Re-exports the typed registry port + in-memory adapter + 2 built-in sinks.
 * Surfaces import from `@/observability/metrics`; the parent
 * `@/observability` barrel intentionally does NOT pull this in (Default-OFF —
 * surfaces opt-in by importing the sub-barrel explicitly).
 */

export { consoleMetricsSink } from "./console-sink"
export { defaultMetricsRegistry, type InMemoryRegistryOpts } from "./in-memory-registry"
export { jsonlMetricsSink } from "./jsonl-sink"
export {
  type MetricKind,
  type MetricSample,
  type MetricSink,
  type MetricSnapshot,
  MetricsError,
  type MetricsErrorCode,
  type MetricsRegistry,
} from "./port"

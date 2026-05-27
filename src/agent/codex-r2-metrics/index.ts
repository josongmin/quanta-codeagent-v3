/**
 * ADR-0352 — Codex-r2 observability metrics decorators.
 *
 * Two wrapping decorators that emit hit/miss/eviction counters as
 * cache + session-registry methods are called. Default-OFF: nothing in
 * the codebase wraps automatically. Composition roots opt in by:
 *
 *   1. Wiring a `MetricEmitterPort` (one method delegates to
 *      `MetricsRegistry.increment` and `MetricsRegistry.gauge` —
 *      ADR-0144 production adapter).
 *   2. Wrapping the cache/registry with the decorator at the
 *      composition root.
 */
export { withCacheMetrics } from "./cache-metrics-decorator"
export { withRegistryMetrics } from "./registry-metrics-decorator"
export type { CodexR2MetricsConfig, MetricEmitterPort } from "./types"

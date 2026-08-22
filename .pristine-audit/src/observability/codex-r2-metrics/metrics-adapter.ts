/**
 * ADR-0358 — `adaptMetricsRegistryToEmitter` — composition-root shim from
 * the ADR-0144 typed `MetricsRegistry` port to the agent-side
 * `MetricEmitterPort` (ADR-0352).
 *
 * This is the ONE-LINE shim ADR-0352 §types.ts promised: callers that
 * already own a `MetricsRegistry` (the in-memory adapter
 * `defaultMetricsRegistry()` or any custom OTel/Prometheus implementation
 * conforming to the typed port) pass it through this function and receive
 * a `MetricEmitterPort` they hand to `withCacheMetrics` /
 * `withRegistryMetrics` (ADR-0352) and to the per-turn activation hook
 * (ADR-0360).
 *
 * # Why two ports
 *
 * `MetricsRegistry` (ADR-0144) is the typed REGISTRY surface — counters
 * record monotonic deltas via `increment(name, delta, labels)`; gauges
 * latest-value-wins via `gauge(name, value, labels)`; histograms via
 * `observe`. It also exposes `snapshot()` / `reset()` / `flush()` for
 * the operator-facing `/metrics` endpoint.
 *
 * `MetricEmitterPort` (ADR-0352 §types.ts) is the EMIT surface — minimal
 * subset (counter + gauge + optional histogram, ADR-0366) that the
 * codex-r2 decorators emit through. ADR-0366 relocated this slice from
 * `@/agent/codex-r2-metrics` to `@/observability/codex-r2-metrics` so
 * the shim and the registry it adapts live in the same plane (composition
 * roots in `@/apps/agent` cross-import via the public surface); the
 * decorators can still be unit-tested without standing up a full
 * registry — `MetricEmitterPort` stays the only emit surface they touch.
 *
 * # Codex OTel attribute vocabulary alignment
 *
 * Codex emits 70+ canonical attribute keys grouped under
 * `codex.{conversation,thread,turn,mcp,tool,task,multi_agent,startup,…}.*`
 * (memory `codex-otel-attribute-vocabulary`). The codex-r2 decorators
 * emit under the `codex_r2.{cache,registry,activation,…}.*` prefix —
 * 1:1 mappable to OTel via the registry's label set. The adapter
 * preserves labels verbatim so a downstream OTel sink (a future
 * `OtelMetricsRegistry` adapter) inherits the codex namespace shape
 * without re-prefixing inside the decorator.
 *
 * # NO-THROW posture
 *
 * The adapter is a pure delegation — every call lands directly on
 * `registry.increment` / `registry.gauge`. The registry contract
 * (`MetricsRegistry` JSDoc) already documents that non-finite values
 * are silently coerced to 0, so even a hostile caller cannot poison
 * the underlying registry. The DECORATORS wrap emit in try/catch
 * (ADR-0352 `safeEmit`), so a buggy registry implementation cannot
 * propagate. Both layers together give defence-in-depth.
 *
 * # Default-OFF
 *
 * Nothing in this file constructs a registry. Composition roots opt
 * in by:
 *
 *   1. Building (or receiving) a `MetricsRegistry` instance.
 *   2. Calling `adaptMetricsRegistryToEmitter(registry)`.
 *   3. Passing the returned emitter to `withCacheMetrics(...)` and/or
 *      assigning it to `cfg.metricsEmitter` for ADR-0360 activation
 *      telemetry.
 *
 * Absent registry ⇒ no adapter is built ⇒ the agent runs byte-identical
 * to the pre-ADR-0358 baseline.
 */

import type { MetricsRegistry } from "@/observability/metrics/port"
import type { MetricEmitterPort } from "./types"

/**
 * Adapt an ADR-0144 `MetricsRegistry` to the ADR-0352
 * `MetricEmitterPort` surface.
 *
 * The returned port:
 *
 *   - `counter(name, delta, attrs)`    ⇒ `registry.increment(name, delta, attrs)`
 *   - `gauge(name, value, attrs)`      ⇒ `registry.gauge(name, value, attrs)`
 *   - `histogram(name, value, attrs)`  ⇒ `registry.observe(name, value, attrs)` (ADR-0366)
 *
 * Labels (`attrs`) are passed through as-is. The codex-r2 decorators
 * supply `Readonly<Record<string,string>>`; the registry signature
 * accepts `Record<string,string> | undefined`, so the cast erases the
 * `readonly` brand without copying. This is sound because the registry
 * never mutates the labels — it uses them only to compute the
 * series-id key.
 *
 * # Histogram (ADR-0366)
 *
 * `histogram` is provided unconditionally by the adapter even though
 * `MetricEmitterPort.histogram` is OPTIONAL — callers that have a real
 * registry always get the full surface. Wrapped in try/catch so a
 * misbehaving `registry.observe` (e.g., a custom OTel adapter that
 * throws on malformed values) cannot poison decorator code paths.
 * The shipped decorators (cache + registry) do NOT call `histogram`
 * today; the method exists so sibling slices (per-turn timing, plan
 * queue latency, etc.) can emit through the same port without
 * widening it further.
 *
 * Adapter is intentionally a closure factory (NOT a stateless top-level
 * fn) so multiple registries can be wired without aliasing — calling
 * `adaptMetricsRegistryToEmitter(r1)` and `adaptMetricsRegistryToEmitter(r2)`
 * returns two independent emitters bound to their respective registries.
 */
export const adaptMetricsRegistryToEmitter = (registry: MetricsRegistry): MetricEmitterPort => ({
  counter: (name, delta, attrs) => {
    registry.increment(name, delta, attrs as Record<string, string> | undefined)
  },
  gauge: (name, value, attrs) => {
    registry.gauge(name, value, attrs as Record<string, string> | undefined)
  },
  histogram: (name, value, attrs) => {
    try {
      registry.observe(name, value, attrs as Record<string, string> | undefined)
    } catch {
      // best-effort — a buggy `observe` MUST NOT poison the emit path.
    }
  },
})

/**
 * Structural duck-test: does the supplied value look like an ADR-0144
 * `MetricsRegistry`?
 *
 * Returns true iff the value is a non-null object that exposes both
 * `increment` and `gauge` as functions (the two methods the adapter
 * actually invokes). The check is INTENTIONALLY narrow — we do NOT
 * insist on `observe` / `snapshot` / `reset` / `flush` even though the
 * full port specifies them, because the adapter never calls those. A
 * partial mock that only implements the emit surface works.
 *
 * This is the seam composition roots use when `cfg.metrics` is typed
 * loosely (e.g., the legacy `Metrics` class in
 * `@/observability/metrics.ts` does NOT have `increment`, so the duck
 * test returns false and the wire skips wrapping — byte-identical
 * legacy posture preserved).
 */
export const looksLikeMetricsRegistry = (value: unknown): value is MetricsRegistry => {
  if (value === null || typeof value !== "object") return false
  const v = value as { increment?: unknown; gauge?: unknown }
  return typeof v.increment === "function" && typeof v.gauge === "function"
}

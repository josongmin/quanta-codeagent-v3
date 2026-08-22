/**
 * ADR-0352 — Codex-r2 observability metrics types (relocated by
 * ADR-0366 from `@/agent/codex-r2-metrics`).
 *
 * Two decorators wrap the ADR-0326 system-prompt cache + ADR-0345 session
 * registry to emit hit/miss/eviction counters as they happen. Each
 * decorator preserves return values verbatim (byte-identical) and is
 * NO-THROW: a misbehaving emitter is swallowed so observability
 * instrumentation cannot break the host.
 *
 * The slice declares its OWN minimal `MetricEmitterPort` rather than
 * exposing `MetricsRegistry` directly — composition roots adapt the
 * typed registry to the emit surface via `adaptMetricsRegistryToEmitter`.
 * That keeps the decorators decoupled from the full registry (they only
 * need counter/gauge/optional-histogram), so unit tests can stub the
 * emitter with three function literals.
 */

/** Minimal port the decorators emit through. Orthogonal to ADR-0144
 *  `MetricsRegistry` — the composition root adapts via a thin shim
 *  (methods delegating to `registry.increment` / `registry.gauge` /
 *  `registry.observe`).
 *
 *  Implementations MUST NOT throw — the decorator wraps each call in
 *  try/catch anyway, but the contract is "emit is best-effort". */
export interface MetricEmitterPort {
  /** Monotonic counter increment. `delta` defaults to 1 (callers may
   *  pass a larger delta for batch emits, e.g. clearAll). */
  counter(name: string, delta: number, attrs?: Readonly<Record<string, string>>): void
  /** Latest-value-wins gauge. */
  gauge(name: string, value: number, attrs?: Readonly<Record<string, string>>): void
  /** Histogram observation (ADR-0366). OPTIONAL — emitter literals
   *  authored before ADR-0366 omit this method, and the shipped
   *  decorators (cache + registry) do NOT call it. The composition-root
   *  adapter (`adaptMetricsRegistryToEmitter`) ALWAYS provides this
   *  method when a real `MetricsRegistry` is available, mapping to
   *  `registry.observe(name, value, attrs)`. Sibling slices (per-turn
   *  timing, plan-queue latency) may emit through this surface without
   *  widening the port further.
   *
   *  Callers MUST guard with optional-call:
   *
   *    emitter.histogram?.("codex_r2.turn.duration_ms", ms)
   *
   *  Implementations MUST NOT throw. */
  histogram?(name: string, value: number, attrs?: Readonly<Record<string, string>>): void
}

/** Decorator config. */
export interface CodexR2MetricsConfig {
  readonly emitter: MetricEmitterPort
  /** Prefix prepended to every metric name. Default `"codex_r2"` so the
   *  whole absorption cycle's metrics group under a single namespace. */
  readonly prefix?: string
}

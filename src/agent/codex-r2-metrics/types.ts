/**
 * ADR-0352 — Codex-r2 observability metrics types.
 *
 * Two decorators wrap the ADR-0326 system-prompt cache + ADR-0345 session
 * registry to emit hit/miss/eviction counters as they happen. Each
 * decorator preserves return values verbatim (byte-identical) and is
 * NO-THROW: a misbehaving emitter is swallowed so observability
 * instrumentation cannot break the host.
 *
 * The slice declares its OWN minimal `MetricEmitterPort` rather than
 * importing `@/observability/metrics` directly — this keeps the
 * agent-side slice plane-clean and lets composition roots adapt to
 * `MetricsRegistry` via a one-line shim (the production adapter is
 * documented in the ADR).
 */

/** Minimal port the decorators emit through. Orthogonal to ADR-0144
 *  `MetricsRegistry` — the composition root adapts via a thin shim
 *  (one method delegating to `registry.increment` / `registry.gauge`).
 *
 *  Implementations MUST NOT throw — the decorator wraps each call in
 *  try/catch anyway, but the contract is "emit is best-effort". */
export interface MetricEmitterPort {
  /** Monotonic counter increment. `delta` defaults to 1 (callers may
   *  pass a larger delta for batch emits, e.g. clearAll). */
  counter(name: string, delta: number, attrs?: Readonly<Record<string, string>>): void
  /** Latest-value-wins gauge. */
  gauge(name: string, value: number, attrs?: Readonly<Record<string, string>>): void
}

/** Decorator config. */
export interface CodexR2MetricsConfig {
  readonly emitter: MetricEmitterPort
  /** Prefix prepended to every metric name. Default `"codex_r2"` so the
   *  whole absorption cycle's metrics group under a single namespace. */
  readonly prefix?: string
}

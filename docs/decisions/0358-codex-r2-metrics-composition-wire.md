# ADR-0358 — Codex-r2 metrics composition wire (cache decorator + emitter side-channel)

## Status

Accepted — 2026-05-27.

## Context

ADR-0352 landed two observability decorators (`withCacheMetrics` /
`withRegistryMetrics`) over the ADR-0326 system-prompt cache and the
ADR-0345 session-resource registry. The decorators emit through a
minimal agent-side `MetricEmitterPort` (counter + gauge) by design —
the agent slice MUST stay plane-clean from `@/observability/metrics`
so the decorators are unit-testable without standing up a full
registry.

But ADR-0352 left two gaps that turned the decorators into permanent
dead code at the composition root:

1. No shim from the ADR-0144 typed `MetricsRegistry` port (the
   operator-facing registry surface with `increment` / `observe` /
   `gauge` + `snapshot` / `reset` / `flush`) to the agent-side
   `MetricEmitterPort`. ADR-0352 §types.ts promised a one-line
   composition-root shim; that shim never landed.
2. No composition root actually wraps the session cache with the
   decorator. The slot stays unwrapped ⇒ no cache hit/miss counters
   ⇒ no operator observability over the warm-cache hit rate that
   ADR-0326 + ADR-0345 deliver.

Codex's OTel attribute vocabulary (memory
`codex-otel-attribute-vocabulary`) emits 70+ canonical keys grouped
under `codex.{conversation,thread,turn,mcp,tool,task,multi_agent,…}.*`
— 1:1 mappable onto the codex-r2 `codex_r2.{cache,registry,…}.*` shape
the ADR-0352 decorators already produce. The missing wire blocks any
downstream OTel sink from receiving those samples.

## Decision

Two leaf additions, no type-surface mutations:

### A. `adaptMetricsRegistryToEmitter(registry)` — ADR-0144 → ADR-0352 shim

A one-line shim in `src/agent/codex-r2-metrics/metrics-adapter.ts`:

```ts
export const adaptMetricsRegistryToEmitter = (registry: MetricsRegistry): MetricEmitterPort => ({
  counter: (name, delta, attrs) => {
    registry.increment(name, delta, attrs as Record<string, string> | undefined)
  },
  gauge: (name, value, attrs) => {
    registry.gauge(name, value, attrs as Record<string, string> | undefined)
  },
})
```

Companion duck-test `looksLikeMetricsRegistry(value)` narrows
structurally: returns `true` iff `value` is a non-null object with
`increment` AND `gauge` as functions. INTENTIONALLY narrow — we do
not insist on `observe` / `snapshot` because the adapter never calls
those. Legacy `Metrics` class from `@/observability/metrics.ts`
(which has `counter(name).inc(delta)` shape, not `increment(name, …)`)
correctly fails the duck test ⇒ wire skip ⇒ byte-identical posture
preserved.

### B. `apps/agent/assemble.ts` wires when a registry-shaped recorder is set

Single 12-line mutation around the existing `installCodexR2Wires`
call:

```ts
const metricsEmitter: MetricEmitterPort | undefined =
  cfg.metrics !== undefined && looksLikeMetricsRegistry(cfg.metrics)
    ? adaptMetricsRegistryToEmitter(cfg.metrics)
    : undefined
const baseCache = sessionResources?.cache ?? createInMemorySystemPromptCache()
const wrappedCache: SystemPromptCachePort =
  metricsEmitter !== undefined && sessionResources !== null && cfg.systemPromptCache === undefined
    ? withCacheMetrics(baseCache, { emitter: metricsEmitter })
    : baseCache
if (metricsEmitter !== undefined) {
  ;(cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter = metricsEmitter
}
installCodexR2Wires(cfg, {
  …
  systemPromptCache: wrappedCache,
  …
})
```

Gating conditions are conjunctive:

1. `cfg.metrics` is set AND structurally a `MetricsRegistry` (duck
   test). Hosts passing the legacy `Metrics` class take the
   byte-identical path.
2. `sessionResources !== null` — bench surface (ADR-0334 row 4) has
   no `sessionId` ⇒ no cache to wrap ⇒ wire skip preserves replay
   determinism.
3. `cfg.systemPromptCache === undefined` — caller-override-precedence
   (ADR-0332): if the host pre-supplied a cache, we never wrap it
   (the operator may be wrapping themselves at a higher layer).

The structural side-channel `(cfg as {…}).metricsEmitter = …` exposes
the adapted emitter to ADR-0360 (per-turn activation telemetry)
without mutating the `AgentConfig` type surface. The
`ActivationHookConfigLike` local interface in `loop-activation-hook.ts`
declares the field, so the loop reads it via structural narrow.

## Non-goals

- **No `withRegistryMetrics` wrap at composition root.** The
  `SessionResourceRegistry` is a process-level singleton accessed via
  `getGlobalSessionResourceRegistry()` — wrapping the global affects
  every subsequent assemble. That's a separate decision (replace the
  singleton getter with a wrapped factory, or expose a per-cfg
  registry) and is left to a follow-up ADR.
- **No `TypedHistoryEventStore` wrap.** The store is a different
  port (ADR-0320) — telemetry over typed-event appends would require
  a third decorator surface, out of scope here.
- **No `histogram` method on `MetricEmitterPort`.** Latency / size
  distributions emit as `sum_…` counters (Option B in ADR-0360);
  operators compute mean via `sum / count`. This keeps ADR-0352's
  2-method port shape intact.
- **No `AgentConfig.metricsEmitter` type field.** The structural side-
  channel keeps the type-level slice fence clean; only this slice and
  the activation hook read the field.

## Codex OTel attribute vocabulary alignment

The decorators emit `codex_r2.{cache,registry}.{hits,misses,…}` with
labels for `reason` (cache invalidation) / `kind`-like attributes.
The shim preserves labels verbatim so a downstream `otelMetricsSink`
(already wired through the registry's `MetricSink` port) inherits the
codex namespace shape 1:1 with the Codex `codex.cache.*` family.
The 70+-key Codex vocabulary maps onto the v3 namespace by replacing
the leading `codex.` with `codex_r2.` and adopting the same
`<system>.<resource>.<event>` shape.

## NO-THROW

Three independent layers:

1. The adapter is pure delegation — no try/catch. A registry that
   throws will throw out of the adapter (the decorator wraps emit in
   `safeEmit` anyway).
2. The decorators (ADR-0352) wrap each emit in try/catch — hostile
   registry implementations cannot poison cache reads/writes.
3. `looksLikeMetricsRegistry` is pure shape inspection — no throw on
   null / primitives / partial objects.

## Default-OFF + caller-override-precedence

- `cfg.metrics === undefined` ⇒ no adapter built, no wrap, byte-identical legacy.
- `cfg.metrics` is legacy `Metrics` class ⇒ duck test rejects, no wrap, byte-identical legacy.
- `cfg.systemPromptCache !== undefined` (caller-supplied) ⇒ no wrap (ADR-0332).
- `sessionResources === null` (no `sessionId`, e.g., bench) ⇒ no wrap (ADR-0334).

## Slice fence

- Touched: `src/agent/codex-r2-metrics/metrics-adapter.ts` (new),
  `src/agent/codex-r2-metrics/index.ts` (re-export), `apps/agent/assemble.ts`
  (12-line mutation), `src/agent/codex-r2-metrics/__tests__/metrics-adapter.hellgate.test.ts` (new),
  `tests/unit/composition-codex-r2-metrics-wire-hellgate.test.ts` (new).
- NOT touched: `src/agent/types.ts`, `src/agent/loop.ts`, `src/agent/prompt-body.ts`,
  `src/agent/codex-r2-wire-install/*`, `src/observability/metrics/port.ts`.

## Hellgate coverage

- Adapter battery (10 cases): A delegation / B gauge / C undefined attrs
  pass-through / D throwing registry propagates / E delta=0 / F sequential
  ordering / G–I duck-test acceptance + rejections / J no aliasing between
  registries.
- Composition battery (6 cases): §1 metrics absent / §2 legacy shape /
  §3 wrap installed + cache emits / §4 bench skip / §5 caller cache
  preserved / §6 emitter exposed for ADR-0360.

## References

- ADR-0144 — typed `MetricsRegistry` port
- ADR-0326 — system-prompt cache
- ADR-0332 — `installCodexR2Wires` composition helper + caller-override-precedence
- ADR-0334 — composition-root deps policy (4 surfaces)
- ADR-0345 — session-resource registry
- ADR-0352 — codex-r2 observability decorators + `MetricEmitterPort`
- ADR-0360 — activation hook telemetry (this slice's structural side-channel consumer)
- Memory `codex-otel-attribute-vocabulary` — Codex OTel keys

# ADR-0352 — Codex-r2 observability metrics

Status: Accepted
Date: 2026-05-27

## Context

ADR-0326 (system-prompt cache) and ADR-0345 / ADR-0348 (session-resource
registry, in-memory + jsonl-disk) both expose `stats()` methods, but
nothing wires those reads into the project's metric system
(`@/observability/metrics`, ADR-0144 `MetricsRegistry`). The cache+registry
work is therefore invisible at the operator panel — there is no way to
see hit-rate, eviction count, or cache size live.

## Decision

Ship two wrapping decorators in a new leaf slice
`src/agent/codex-r2-metrics/`:

- `withCacheMetrics(inner, cfg): SystemPromptCachePort` — emits
  `codex_r2.cache.{hits,misses,peek_hits,peek_misses,invalidations,size}`
  on each port method.
- `withRegistryMetrics(inner, cfg): SessionResourceRegistry` — emits
  `codex_r2.registry.{hits,misses,peek_hits,peek_misses,evictions,size}`.

Both decorators preserve the underlying port's return value verbatim.
Both are **NO-THROW**: a `try/catch` wraps every emit so a misbehaving
emitter cannot break the cache or registry hot path.

### Orthogonal port — `MetricEmitterPort`

The slice declares its own minimal port instead of importing
`@/observability/metrics` directly:

```ts
interface MetricEmitterPort {
  counter(name: string, delta: number, attrs?: Readonly<Record<string, string>>): void
  gauge(name: string, value: number, attrs?: Readonly<Record<string, string>>): void
}
```

Rationale: `@/agent` should not gain a hard dependency on
`@/observability/metrics`. Composition roots adapt the production
`MetricsRegistry` via a one-line shim:

```ts
const emitter: MetricEmitterPort = {
  counter: (name, delta, attrs) => registry.increment(name, delta, attrs),
  gauge:   (name, value, attrs) => registry.gauge(name, value, attrs),
}
```

### Counter taxonomy

| Counter | Fires when |
| --- | --- |
| `codex_r2.cache.misses` | `getOrBuild` builds (key was absent) |
| `codex_r2.cache.hits` | `getOrBuild` reuses (key was present) |
| `codex_r2.cache.peek_hits` / `.peek_misses` | `peek()` outcome |
| `codex_r2.cache.invalidations` | `invalidate(key)` for present key, or `clearAll` (delta = entries dropped); both carry the `reason` enum as an attr |
| `codex_r2.cache.size` | gauge emitted on `stats()` calls |
| `codex_r2.registry.*` | mirror semantics on the registry port |
| `codex_r2.registry.size` | gauge updated on every mutation + read |

The `clearAll` delta semantics matter: with N entries we emit ONE
counter sample whose delta is N (not N samples of delta 1), so the
downstream operator sees the bulk drop as a single event.

### Default-OFF

Nothing in the codebase wraps automatically. Composition roots opt in:

```ts
const cache = withCacheMetrics(createInMemorySystemPromptCache(), { emitter })
const registry = withRegistryMetrics(getGlobalSessionResourceRegistry(), { emitter })
```

`prefix` config defaults to `"codex_r2"` so every R3-R8 absorption
metric falls under a single namespace. Operators may override per-deploy.

## Non-goals

- **Production wire-up of the cache/registry singletons.** A future ADR
  (composition root mutation) decides whether to wrap inside
  `assemble.ts` automatically or only when the
  `QUANTA_METRICS_OBSERVE_CODEX_R2` env var is set. Out of scope here.
- **Drift-detector metrics (`DriftDetectedError` count).** ADR-0326's
  `makeStrictDriftCache` is the obvious next candidate; the decorator
  pattern carries over but is a separate ADR.
- **Histogram observations** (e.g. cache build duration). The
  decorators are counter+gauge only. Latency observation requires a
  histogram on `MetricEmitterPort` — separate ADR.

## Tests

- `src/agent/codex-r2-metrics/__tests__/cache-metrics.hellgate.test.ts` — 11
  cases: identity preservation, hit/miss/invalidation, peek read-only
  split, clearAll batch delta, emitter-throw swallow, prefix override,
  stats() gauge.
- `src/agent/codex-r2-metrics/__tests__/registry-metrics.hellgate.test.ts` — 8
  cases: first miss + size gauge, repeat hit, evict, evict-absent
  no-op, clear with delta, peek split, emitter throw, prefix override.

`bun test src/agent/codex-r2-metrics/__tests__/` ⇒ 19 pass / 0 fail / 37
expects.

## Consequences

- **Operators get live cache + registry telemetry** with a single
  composition-root wrap. No core code change.
- **Decorator pattern** is consistent with ADR-0337 (image-retry
  wrapping), ADR-0326 (drift detector wrapping) — the codebase now has
  a clear "wrap-port-to-add-X" idiom.
- **Plane-clean.** `src/agent/codex-r2-metrics/` imports only
  `@/agent/session-resource-registry` and `@/llm/system-prompt-cache`
  for type information. No transitive observability dependency.

## References

- ADR-0144 — MetricsRegistry / MetricSink (port the shim adapts to)
- ADR-0326 — System-prompt cache (one of two wrapped ports)
- ADR-0345 / ADR-0348 — Session-resource registry (other wrapped port)
- ADR-0337, ADR-0326 drift-detector — sibling wrap patterns

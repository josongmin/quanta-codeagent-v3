# ADR-0366 — codex-r2-metrics slice relocation + histogram method (R11 W-B retry)

Status: accepted (R12 retry of R11 W-B `f2fdbdfe`)
Date: 2026-05-27
Depends on: ADR-0352 (codex-r2 metrics decorators), ADR-0358 (composition wire), ADR-0360 (activation telemetry), ADR-0364 (file-lock telemetry)
Supersedes: nothing on main (R11 W-B `f2fdbdfe` was aborted before cherry-pick)

## Context

### R11 W-B failure

R11 W-B (`f2fdbdfe`) attempted the same slice relocation. The branch was
authored against an older main snapshot that did NOT yet contain the
following import sites:

- `src/apps/agent/assemble.ts` (ADR-0358, landed in main `397fd39a`) —
  runtime imports `adaptMetricsRegistryToEmitter` /
  `looksLikeMetricsRegistry` / `withCacheMetrics` /
  `type MetricEmitterPort`.
- `src/agent/loop-activation-hook.ts` (ADR-0360, landed in main
  `397fd39a`) — `import type { MetricEmitterPort }`.
- `src/agent/session-resource-registry/disk-adapter/file-lock.ts`
  (ADR-0364, landed in main `8291f3a5`) — `import type { MetricEmitterPort }`.
- `src/agent/session-resource-registry/disk-adapter/types.ts` (ADR-0364
  sibling) — `import type { MetricEmitterPort }`.
- `src/agent/session-resource-registry/disk-adapter/__tests__/file-lock-telemetry.hellgate.test.ts`
  (ADR-0364 sibling) — `import type { MetricEmitterPort }`.
- `tests/unit/composition-codex-r2-metrics-wire-hellgate.test.ts`
  (ADR-0358 sibling) — `import type { MetricEmitterPort }`.
- `tests/unit/loop-activation-telemetry-hellgate.test.ts` (ADR-0360
  sibling) — `import type { MetricEmitterPort }`.

W-B moved the slice files but missed every consumer above, so cherry-pick
aborted on a thicket of `cannot find module '@/agent/codex-r2-metrics'`
errors. This retry is **main-aware**: the worktree was ff-merged onto
`main` (28dcac90) BEFORE any source edits, and all consumer sites were
grepped + rewritten in the same change.

### Why move the slice

The ADR-0352 absorption planted the codex-r2 metrics slice under
`@/agent/codex-r2-metrics` for plane-cleanliness during initial wiring
(decorators imported only types from `@/observability`, never reached
back). With ADR-0358 the wire landed and the slice now serves two
roles:

1. Emit-port surface for ADR-0352 decorators (cache + registry).
2. Adapter shim translating the typed `MetricsRegistry`
   (`@/observability/metrics/port`) to the emit-port surface.

Role 2 is structurally an observability concern — the adapter exists to
bridge two observability ports. Keeping the slice under `@/agent`
created an artificial seam every composition root had to re-cross. The
relocation moves the slice into `@/observability/codex-r2-metrics`
where:

- It sits adjacent to `@/observability/metrics/port`.
- Composition roots in `@/apps/agent` import it through the public
  `@/observability` surface — no fence work needed.
- Library consumers (`@/agent/**` files that hold a `MetricEmitterPort`
  reference) use `import type` only, which is exempt from the
  noRestrictedImports runtime fence (verified in R11 W-B audit).

### Why histogram now

The ADR-0144 `MetricsRegistry` port has three emit surfaces:
`increment` / `gauge` / `observe`. The adapter only exposed
`increment` + `gauge` because the ADR-0352 decorators emit counter +
gauge only. Sibling slices landing alongside this retry (per-turn
duration, plan-queue wait latency) want to emit observations through
the same `MetricEmitterPort` reference they already hold — widening the
adapter once is cheaper than threading `MetricsRegistry` through every
hot path. The method is **optional** on the port so emitter literals
authored before ADR-0366 stay valid.

## Decision

### D1 — Slice relocation (5 production files + 3 test files)

Move via `git mv` so blame history follows:

```
src/agent/codex-r2-metrics/types.ts
  → src/observability/codex-r2-metrics/types.ts
src/agent/codex-r2-metrics/cache-metrics-decorator.ts
  → src/observability/codex-r2-metrics/cache-metrics-decorator.ts
src/agent/codex-r2-metrics/registry-metrics-decorator.ts
  → src/observability/codex-r2-metrics/registry-metrics-decorator.ts
src/agent/codex-r2-metrics/metrics-adapter.ts
  → src/observability/codex-r2-metrics/metrics-adapter.ts
src/agent/codex-r2-metrics/index.ts
  → src/observability/codex-r2-metrics/index.ts

src/agent/codex-r2-metrics/__tests__/cache-metrics.hellgate.test.ts
  → tests/unit/codex-r2-metrics-cache-hellgate.test.ts
src/agent/codex-r2-metrics/__tests__/registry-metrics.hellgate.test.ts
  → tests/unit/codex-r2-metrics-registry-hellgate.test.ts
src/agent/codex-r2-metrics/__tests__/metrics-adapter.hellgate.test.ts
  → tests/unit/codex-r2-metrics-adapter-hellgate.test.ts
```

Test relocation is partly fence pragmatism: tests live under
`tests/unit/` everywhere new code lands, and the `__tests__/`
co-located pattern was a hold-over from the initial ADR-0352 slice.
The biome `slice-fence` invariant tolerates either but the unit-test
directory is the canonical home.

### D2 — Consumer import path rewrite (7 files)

| file                                                                                       | shape         |
| ------------------------------------------------------------------------------------------ | ------------- |
| `src/apps/agent/assemble.ts`                                                               | runtime + type |
| `src/agent/loop-activation-hook.ts`                                                        | type          |
| `src/agent/session-resource-registry/disk-adapter/file-lock.ts`                            | type          |
| `src/agent/session-resource-registry/disk-adapter/types.ts`                                | type          |
| `src/agent/session-resource-registry/disk-adapter/__tests__/file-lock-telemetry.hellgate.test.ts` | type          |
| `tests/unit/composition-codex-r2-metrics-wire-hellgate.test.ts`                            | type          |
| `tests/unit/loop-activation-telemetry-hellgate.test.ts`                                    | type          |

All rewrite `@/agent/codex-r2-metrics` → `@/observability/codex-r2-metrics`.

### D3 — Histogram method on MetricEmitterPort (optional)

Widen the port:

```ts
export interface MetricEmitterPort {
  counter(name: string, delta: number, attrs?: Readonly<Record<string,string>>): void
  gauge(name: string, value: number, attrs?: Readonly<Record<string,string>>): void
  /** Histogram — OPTIONAL — pre-0366 emitter literals omit this. */
  histogram?(name: string, value: number, attrs?: Readonly<Record<string,string>>): void
}
```

The composition adapter (`adaptMetricsRegistryToEmitter`) provides
`histogram` unconditionally, mapping to `registry.observe`:

```ts
histogram: (name, value, attrs) => {
  try {
    registry.observe(name, value, attrs as Record<string,string> | undefined)
  } catch {
    // best-effort — defend the emit path
  }
}
```

NO-THROW posture: `observe` is wrapped in try/catch INSIDE the adapter
(asymmetric with `counter`/`gauge` which propagate). The asymmetry is
deliberate — observation is a fire-and-forget signal where data loss
on a misbehaving registry beats poisoning the caller's hot path; for
counter/gauge the decorator layer already owns `safeEmit` so propagation
is correct there.

The shipped decorators (cache + registry, ADR-0352) do NOT call
`histogram` and are unchanged.

## Non-goals

- Histogram on the port is OPTIONAL. We do NOT force every emitter
  literal in the codebase to add the method.
- The shipped decorators are NOT modified. Adding histogram to
  cache/registry metrics would change byte-identical guarantees.
- A "drift detector" counter alluded to by an internal review is a
  sibling ADR; out of scope here.

## Consequences

### Wins

- W1. Plane alignment — adapter and the registry it adapts live in
  the same plane. Composition-root reasoning simpler.
- W2. R11 W-B unblocked — the work salvageable, with main-aware
  retry pattern documented.
- W3. Histogram channel — sibling slices can emit observations
  through `MetricEmitterPort` without widening or re-wiring.
- W4. Backward compat — emitter literals lacking histogram still
  type-check via `histogram?` optional. Default-OFF.

### Trade-offs

- T1. Asymmetric NO-THROW — counter/gauge propagate but histogram
  swallows. Documented in the JSDoc; tests pin both shapes.
- T2. Cross-plane type import — agent slice files now hold
  `import type` against `@/observability`. `noRestrictedImports`
  exempts type-only imports so the fence stays green.

### R11 W-B salvage map

| artifact                                       | source                  | shape vs W-B                  |
| ---------------------------------------------- | ----------------------- | ----------------------------- |
| moved slice files (5)                          | R11 W-B design          | byte-identical move plan      |
| moved tests (3, renamed)                       | R11 W-B design          | new test names match fence    |
| 7 consumer import path rewrites                | **new in this retry**   | W-B missed all 7              |
| histogram on `MetricEmitterPort` (optional)    | R11 W-B design          | port shape preserved          |
| `adaptMetricsRegistryToEmitter.histogram`      | R11 W-B design          | NO-THROW wrap added in retry  |
| ADR-0366 histogram hellgate (K–P, 6 cases)     | **new in this retry**   | W-B had no test for `O`/`P`   |

## Verify

- `bun test` on the 5 codex-r2 + activation + composition files:
  49 pass / 0 fail / 107 expect.
- `bun test` on `disk-adapter/__tests__/`: 69 pass / 0 fail.
- Combined cluster: 118 pass / 0 fail / 284 expect.
- biome on slice + 7 consumers: clean (only safe-fix was
  import-ordering after the rewrite, applied).
- tsc: 0 errors in the slice. 32 pre-existing errors elsewhere
  (`src/tool/coverage_check.ts` + 6 `tests/unit/coverage-*.test.ts`)
  are unrelated and pre-date this change.

## Negative invariants

- N1. `src/agent/codex-r2-metrics/` MUST NOT be re-created.
- N2. Histogram MUST stay OPTIONAL on `MetricEmitterPort`.
- N3. Cache + registry decorators MUST NOT call `histogram` (changing
  byte-identical guarantees) — sibling slices may.
- N4. Consumer files that hold a `MetricEmitterPort` reference must
  import via `import type` from `@/observability/codex-r2-metrics`
  (runtime cross-plane imports stay only in `@/apps/agent`).

## Files

- new: `docs/decisions/0366-codex-r2-metrics-relocation-and-histogram-retry.md`
- moved (git mv): 5 src files + 3 test files (see D1).
- edited: 7 consumer import sites (see D2) + types.ts/metrics-adapter.ts
  histogram surface (see D3).

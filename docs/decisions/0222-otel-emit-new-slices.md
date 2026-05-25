# ADR-0222: OTel emit unified across 5 new slices (fence-aware narrow ports)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Note on number**: this ADR was authored as 0212 in the source RFC. ADR-0212
  (sticky-model-per-mode) was already taken; per the `adr-collision-policy`
  user-deference renumber rule, this ADR was bumped to the next-free slot.
- **Related ADRs**: ADR-0144 (typed MetricsRegistry port), ADR-0158/0159
  (instrument wrap pattern — typed wrappers around already-shipped ports),
  ADR-0032 / Wave-D vocabulary migration (single source of truth for
  `quanta.*` keys), ADR-0203 (error-routing slice), ADR-0204 (shell-snapshot
  slice), ADR-0205 (git-directives slice), ADR-0200 (stream-timeout slice)
- **References**: `src/observability/vocabulary.ts`,
  `src/observability/metrics/new-slice-instruments.ts`,
  `src/observability/metrics/wire-new-slices.ts`,
  `src/agent/error-routing/metric-port.ts`,
  `src/agent/error-routing/no-op-metric.ts`,
  `src/runtime/shell-snapshot/metric-port.ts`,
  `src/runtime/shell-snapshot/no-op-metric.ts`,
  `src/agent/git-directives/metric-port.ts`,
  `src/agent/git-directives/no-op-metric.ts`,
  `src/agent/stream-timeout/metric-port.ts`,
  `src/agent/stream-timeout/no-op-metric.ts`,
  `tests/unit/observability/new-slice-metrics-hellgate.test.ts`

## Context

Four of the five new leaf slices shipped over the recent rounds need OTel
emission to be useful in production dashboards:

- **error-routing** (ADR-0203) — classify/route counters per kind + per action.
- **shell-snapshot** (ADR-0204) — capture duration + bytes histogram.
- **git-directives** (ADR-0205) — per-directive-kind counter.
- **stream-timeout** (ADR-0200) — idle-ms histogram + timeout-action counter.

(The remaining two — `thread-tools` and `memory/stage1-store` — are explicitly
out of scope for this slice: their "value" is inventory / usage stats best
expressed at the dashboard layer once a consumer wires them. No metric port is
added today.)

The blocker: each slice is plane-clean. The slice-boundary scanner
(`tests/unit/_arch/slice-boundary-scanner.ts`) and the biome
`noRestrictedImports` fence both forbid these slices from importing
`@/observability` directly. Naive "just call `metrics.increment` from inside
the slice" violates the fence — it would couple a leaf primitive to the
observability adapter shape.

The cross-cutting requirement: every slice that emits MUST use a
`quanta.*`-namespaced key registered in `src/observability/vocabulary.ts`.
ADR-0032 / Wave-D's orphan-literal scan
(`tests/unit/observability/vocabulary-migration.test.ts`) fails CI on any
`"quanta.*"` string literal that isn't sourced from the vocabulary module.

## Decision

Apply the same **narrow port + adapter** pattern ADR-0159 used for
`instrumentLlmProvider`, but invert direction:

1. **Each slice defines its own narrow `*Metric` port** alongside its other
   ports (`metric-port.ts`) — a 1-or-2-method interface scoped to exactly the
   call sites the slice has. The port imports ONLY local sibling types.
2. **Each slice ships a `no-op-metric.ts`** — a frozen pass-through default so
   slice clients can wire `noOp*Metric` whenever telemetry is off, with
   byte-identical zero side-effect behaviour.
3. **`src/observability/vocabulary.ts` gains a `slice` sub-tree** with the 6
   new canonical keys:
   - `quanta.error.kind` (counter, label: `kind`)
   - `quanta.error.action` (counter, label: `action`)
   - `quanta.stream.idle_ms` (histogram)
   - `quanta.stream.timeout_action` (counter, label: `action`)
   - `quanta.shell.snapshot_duration_ms` (histogram)
   - `quanta.shell.snapshot_bytes` (histogram)
   - `quanta.git.directive` (counter, label: `kind`)
4. **`src/observability/metrics/new-slice-instruments.ts`** — emit helper
   functions, one per metric, that take a `MetricsRegistry` and call
   `increment` / `observe` against the canonical vocabulary key. These
   functions live in the observability plane so the canonical key reference
   stays inside `@/observability`.
5. **`src/observability/metrics/wire-new-slices.ts`** — adapter factories that
   take a `MetricsRegistry` and return the narrow port shape each slice
   declared. The adapter is the ONLY place that crosses the boundary: slices
   import the port from their own dir; the observability module returns an
   impl of that port.

The slice never sees `@/observability`. The observability module never
imports the slice (it builds an object literal that satisfies the slice's
port shape, which is a plain TypeScript interface). The two halves are
coupled by interface only — exactly the hexagonal seam the architecture
demands.

### Why per-slice ports (not one shared `MetricEmitter` port)?

A single shared port would name-collide method-by-method (which slice does
`recordAction(action: string)` belong to?), and would require widening the
slice-boundary deny-list with a shared module path. The narrow-per-slice
shape keeps each port's vocabulary intrinsic to the slice — the
error-routing port talks about `kind` / `action`, the shell-snapshot port
talks about `durationMs` / `bytes`. The price (5 tiny ports instead of 1) is
paid once, at slice creation, and bought back forever in readability.

## Consequences

- **Default-OFF**: every slice's `no-op-metric.ts` is the byte-identical
  default. No call site is forced to wire telemetry. The slice tests today
  use the no-op and assert zero observable side-effect (HELL-OT-03).
- **Slice fence preserved**: a follow-up slice-boundary scan would still
  refuse `import "@/observability"` from any of the 4 slices; the
  `metric-port.ts` import a slice's *clients* perform is intra-slice
  (`@/agent/error-routing` is the slice's own barrel).
- **Vocabulary single source of truth**: the 6 new keys are declared once in
  `QUANTA_ATTRS.slice` and referenced through the const map by the
  instrument helpers. Wave-D's orphan-literal scan keeps passing — no raw
  literal escapes the vocabulary module.
- **Follow-up Phase 3** (out of scope here): wire dashboard panels +
  alerting thresholds for each metric. The vocabulary is shipped; the
  panels are an operator-side concern.
- **Thread-tools / stage1-store**: their telemetry layer is a dashboard-side
  inventory query against the persisted JSONL — no in-process emit needed
  for the value they deliver. If a future call site DOES need a counter,
  the same pattern applies (narrow port in the slice, adapter in
  observability, vocabulary entry).

## Negative invariants

- The slice MUST NOT import `@/observability` (locked by HELL-OT-02 +
  slice-boundary scanner).
- The vocabulary key MUST be declared in `QUANTA_ATTRS.slice` — no raw
  string literal in any instrument helper (locked by HELL-OT-05 via the
  vocabulary orphan scan).
- The no-op default MUST be a frozen object with zero observable effect
  (locked by HELL-OT-03 via call-count assertion against a spy registry).

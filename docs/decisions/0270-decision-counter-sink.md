# ADR-0270 — Decision → MetricsRegistry Counter Sink

Status: Accepted (2026-05-25)
Slice: `src/observability/metrics/decision-counter-sink.ts`
Related: ADR-0144 (MetricsRegistry port), ADR-0150 (OTel meter-provider sink),
ADR-0267 (`decision` AgentEvent Phase 2 wire), ADR-0268 (OTLP HTTP exporter)

## Context

Phase 2 of the gate-decision cluster (ADR-0267) routed every admissibility-gate
verdict (permission / rule / hook / cap / jail / budget × allow / deny / ask)
through a typed `decision` AgentEvent. The trajectory recorder and the CLI
tracer already consume those events, but the `MetricsRegistry` (ADR-0144)
did not — so the canonical counters operators expect

    quanta.gate.permission.allow.total
    quanta.gate.rule.deny.total
    quanta.gate.hook.ask.total
    ...

never materialized in the in-process snapshot OR the OTLP-exported view
(ADR-0268), even though the underlying decision data was flowing on the
stream.

## Decision

Add a thin `StreamPort` adapter — `createDecisionCounterSink({ metrics, prefix? })`
— that listens for `decision` events and bumps a `MetricsRegistry` counter per
`(kind, outcome)` pair. The counter name follows the existing
`<prefix>.<axis>.<outcome>.total` convention (`prefix` defaults to
`quanta.gate`). The sink is wired into the CLI tee chain at the same position
as the turn-summary collector, gated on `QUANTA_DECISION_METRICS=1` so the
default-OFF byte-identical path is preserved.

### Counter time-series shape

```
${prefix}.${kind}.${outcome}.total          counter
labels = { kind, outcome }
```

### Cardinality invariant (NEGATIVE)

The only counter labels are `kind` and `outcome`. The following high-cardinality
or free-form fields from the `decision` event are DELIBERATELY excluded:

- `toolCallId` — opaque ULID per call, would explode the time-series count.
- `ruleId` — user-authored, no upper bound on distinct values.
- `hookName` — user-authored hook identifier, same risk as `ruleId`.
- `reason` — free-form short string, no closed taxonomy.
- `metadata` — caller-supplied kind-specific context.

At steady state the matrix is 6 (kind) × 3 (outcome) = **18 time-series total**.
Codex, Cursor and Claude Code each learned this lesson the hard way (label-set
explosion on `tool_id` / `req_id`); we adopt the typed-only label set up front.

### Wire seam

Inside `src/apps/cli/repl.ts::buildTurnSummaryAndStream` — the sink is appended
to the same `TeeStream` the turn-summary collector uses (or to a fresh tee
when the summary collector is OFF). Env knob `QUANTA_DECISION_METRICS` gates
construction; when unset / `0|false|off|no` the helper returns the literal
upstream stream (byte-identical, no MetricsRegistry allocated).

## Consequences

- **In-process queries**: `MetricsRegistry.snapshot()` now exposes the 18-series
  gate matrix; future `/metrics` slash command will surface "today: 42 deny / 7
  ask" without any extra emit code.
- **OTLP export (ADR-0268)**: an operator who wires an OTel-backed registry +
  flips `QUANTA_DECISION_METRICS=1` gets Grafana/Tempo dashboards for free.
- **Default-OFF preserved**: the byte-identical no-tee path holds when the env
  knob is unset.
- **Plane-clean**: the sink imports only `@/stream` (types) and `./port`
  (registry). No agent / permission / tool slice coupling.

## Negative invariants

1. No new `MetricsRegistry` port — the existing ADR-0144 port is re-used.
2. The `decision` AgentEvent shape (ADR-0267) is NOT mutated.
3. `toolCallId` / `ruleId` / `hookName` / `reason` / `metadata` are NEVER
   passed as counter labels — see cardinality invariant above.

## Hellgate

`tests/unit/observability/decision-counter-hellgate.test.ts` seals 16
adversarial invariants — 3×3 (kind × outcome) sample, repeat-emit accumulation,
non-decision-event noise rejection, no-throw policy on throwing registry,
custom prefix, cardinality invariant (no extra labels), every-kind support,
empty/whitespace prefix fallback.

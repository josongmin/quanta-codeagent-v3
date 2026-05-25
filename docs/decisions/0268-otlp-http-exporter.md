# ADR-0268: OTLP/HTTP exporter — `QUANTA_OTEL_ENDPOINT` realtime ship

## Context

The OTel scaffold already in tree (`metrics/otel-sink.ts`, `tracing/otel-tracer.ts`, `tracing/w3c-propagator.ts`) gives us the in-process surface: counters, histograms, spans, W3C propagation. But every sample stays in memory — there is no wiring to a real collector. The two `otlp-helper.ts` / `prometheus` factories assume the upstream OTel SDK packages (`@opentelemetry/sdk-metrics` + exporter packages) are installed at the call site; in this tree they are not.

We need an "activate realtime export" toggle that:
- is **Default-OFF** (byte-identical no-op when not configured),
- requires **zero new npm installs** (installs are blocked per env memo),
- speaks the **standard OTLP wire format** so any Collector / Jaeger / Tempo / Honeycomb / Grafana Cloud / Datadog OTLP receiver consumes it.

## Decision

Ship a hand-rolled **OTLP/JSON over HTTP** exporter as a closed-port primitive in `src/observability/otel-exporter.ts`. The exporter:

1. Buffers `ExportSpan` and `ExportMetric` typed records.
2. Flushes via `POST ${endpoint}/v1/traces` and `POST ${endpoint}/v1/metrics` with `Content-Type: application/json`.
3. Triggers flush on **batch-size reach** OR **time interval**.
4. `teardown()` clears the interval and drains pending buffers.
5. Reads `QUANTA_OTEL_ENDPOINT` env var via the `attachOtelExporterFromEnv` composition helper — **unset ⇒ undefined returned ⇒ no-op tracer / no-op sink remain in effect** (byte-identical Default-OFF).

The wire serializer implements the minimum OTLP/proto JSON shape: `resourceSpans` / `resourceMetrics` envelopes with `scopeSpans[]` / `scopeMetrics[]`, `traceId` / `spanId` / `parentSpanId` (16/8-byte hex), `startTimeUnixNano` / `endTimeUnixNano` (nanos as string per spec), `attributes` as the OTLP tagged-union KeyValue list.

Two bridge fns let an existing `MetricsRegistry` / `Tracer` plug into the exporter without restructuring:
- `exporterMetricSink(exporter)` → a `MetricSink` that forwards every observation to the exporter's metric buffer.
- `buildExportingTracer(exporter, opts)` → a `Tracer` that allocates W3C-shaped IDs and forwards finished spans (via `end()`) to the exporter's span buffer. No in-memory tree — the collector reconstructs parent/child links via `parentSpanId`.

## Env knobs

| Env | Default | Effect |
|---|---|---|
| `QUANTA_OTEL_ENDPOINT` | `undefined` | Composition root: when set, attach helper returns a wired triple. Unset ⇒ undefined returned ⇒ no-op path. |
| `QUANTA_OTEL_SERVICE_NAME` | `"quanta-codeagent"` | `service.name` resource attribute on every envelope. |
| `QUANTA_OTEL_BATCH_SIZE` | `64` | Buffer size that triggers immediate flush. |
| `QUANTA_OTEL_FLUSH_MS` | `5000` | Recurring flush interval. `0` disables the timer (caller flushes manually). |

## Posture

- **No-throw**. Every public method swallows network / serialization errors and logs to the optional `warn` sink. The buffer is NOT drained on failure so the next flush retries.
- **Plane-clean**. Imports only `./tracing/port` (Span types) + `./tracing/noop-tracer` (fallback) + `./metrics/port` (`MetricSink` type). Zero `@/agent` / `@/tool` / `@/llm` imports.
- **No default endpoint**. The exporter requires `endpoint` explicitly. The env helper returns `undefined` when the env is unset/blank — a default localhost endpoint would silently leak observations.
- **Caller-injected `fetch` + `setInterval` + `now`**. Test seam: the hellgate drives the exporter with a fake fetch + manual-tick scheduler + injected clock.

## Non-goals

- OTLP/protobuf serialization (collectors accept JSON at `/v1/{traces,metrics}` universally).
- Auto-installing `@opentelemetry/*` packages at runtime.
- Re-implementing the OTel Context API (the in-process tracer already does that).
- Auto-attaching to the composition root — composition root opt-in is a follow-up wire step, intentionally deferred so this slice stays leaf-only.

## Slice

NEW
- `src/observability/otel-exporter.ts`
- `tests/unit/observability/otel-exporter-hellgate.test.ts`

UNTOUCHED
- `src/observability/metrics/otel-sink.ts` (structural OTel adapter — still valid path when caller has SDK installed)
- `src/observability/tracing/otel-tracer.ts` (in-process OTel API bridge — still valid for surfaces that wire the SDK)
- `src/observability/tracing/port.ts`
- Composition root (`src/runner/assemble/config.ts`) — wiring deferred to a follow-up so this slice stays leaf-only.

## Validation

- 17 hellgate cases covering: 1-span flush, batch-size flush, interval flush, teardown, failure-retain-buffer, large-N batching, metric POST, service.name presence, empty-buffer no-op, clock injection, W3C ID shapes, parent-spanId omission/presence, attribute type round-trip, 1KB attribute pass-through, env-unset returns undefined, env-set wires triple, sink adapter forwarding.
- `bun run typecheck` — slice clean.
- Slice files: 0 `@/agent` / `@/tool` / `@/llm` imports.

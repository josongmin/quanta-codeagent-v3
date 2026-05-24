# ADR-0144: Observability metrics — typed counter/histogram/gauge primitive over `AgentEvent` trace stream

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0035 (jsonl-cumulative-retention — sink-pattern reference), ADR-0124 (conversation-checkpoint — pure primitive sibling), ADR-0138 (token budget ledger — sibling primitive, same default-OFF + plane-clean discipline)
- **SOTA 출처**: Cursor 3.2 IDE-side metrics panel (UI surface only, no programmatic registry); Claude Code 2.1 session totals (UI only, no out-of-process export); Codex Desktop per-model OTel breakdown (export only, no in-process query API); Anthropic / OpenAI SDKs all emit `usage` blocks per completion — none expose a typed `MetricSink` + `MetricsRegistry` pair that lets the operator BOTH query `tool_calls_total` / `turn_duration_ms` / `verify_gate_pass_total` in-process AND pipe samples to an out-of-process collector
- **참조**: `src/observability/metrics/port.ts`, `src/observability/metrics/in-memory-registry.ts`, `src/observability/metrics/console-sink.ts`, `src/observability/metrics/jsonl-sink.ts`, `src/observability/metrics/index.ts`, `tests/unit/observability-metrics-hellgate.test.ts`

## 맥락

quanta 의 observability 평면은 두 surface 를 이미 가지고 있다:

- **trace events** — `src/stream/types.ts` 의 `AgentEvent` discriminated union 이 turn / tool / dispatch 단위의 행위를 emit, ADR-0035 의 `jsonl-recorder` 가 disk 로 record (cumulative + retention)
- **structured logs** — `src/observability/logger.ts` 의 `StructuredLogger` 가 stderr 로 line-per-event JSON 을 write

그러나 다음이 빠져있다 — **operator 가 production 에서 묻는 질문**:

- "지난 1시간 `tool_calls_total{tool=bash}` 가 몇 번 호출됐지?"
- "이번 매트릭스 런의 `turn_duration_ms` p95 / p99 는?"
- "`verify_gate_pass_total` vs `verify_gate_fail_total` 비율은?"
- "현재 in-flight subagent 수 / memory cache 사이즈는?"

이 질문들은 event stream / log line 위에서 ad-hoc grep + jq + awk 로 추출 가능하지만 (a) 타입이 없고 (b) aggregation semantics 가 그때그때 다르며 (c) Prometheus / OTel 같은 out-of-process collector 와 shape 가 매치되지 않는다.

다른 modern agent:
- Claude Code 2.1 — UI panel 의 session totals (programmatic surface 0)
- Cursor 3.2 — IDE-side metrics panel (export 0, query 0)
- Codex Desktop — per-model OTel breakdown (export only, in-process query 0)
- v0.dev — none

= "trace event 와 structured log 위에 typed `counter | histogram | gauge` registry 를 closed-port adapter 로 얹은 첫 슬라이스. 같은 시리즈를 in-process snapshot 으로도 읽고, 동시에 sink 를 통해 OTel / Prometheus / JSONL 로 export 한다."

## 결정

신규 디렉토리 `src/observability/metrics/`:

> **Plane discipline (ADR-0193 정정)**: `port.ts` + `jsonl-sink.ts` + `otel-resource.ts` + `health-snapshot.ts` 는 `@/shared` + node 표준만 import 하지만, 이 슬라이스 전체는 plane-clean 이 **아니다**. `instrument-tool.ts` / `instrument-budget.ts` / `instrument-plan-queue.ts` / `instrument-shadow.ts` / `observability-helper.ts` 는 의도적으로 cross-cutting 이다 — 각각 `@/tool` / `@/agent/budget-ledger` / `@/agent/plan-queue` / `@/agent/subagent-background` / `@/storage/shadow-odb` / `@/llm/providers` / `@/llm` 를 type-only 로 reach 한다. observability layer 의 본성이 cross-cutting 이라 plane-clean 봉인은 부적절 — biome 의 `**/src/observability/**` slice 룰은 이미 enforced (위 import 들이 pre-existing noRestrictedImports 위반으로 잡혀 있음; 본 ADR 의 "plane-clean" 표현이 잘못된 것임).

```ts
type MetricKind = "counter" | "histogram" | "gauge"

interface MetricSample {
  readonly name: string
  readonly kind: MetricKind
  readonly value: number
  readonly labels?: Readonly<Record<string, string>>
  readonly at: number
}

interface MetricSink {
  send(sample: MetricSample): void
  flush?(): Promise<void>
}

interface MetricsRegistry {
  increment(name: string, delta?: number, labels?: Record<string, string>): void
  observe(name: string, value: number, labels?: Record<string, string>): void
  gauge(name: string, value: number, labels?: Record<string, string>): void
  snapshot(): ReadonlyArray<MetricSnapshot>
  reset(): void
  flush(): Promise<void>
}

interface MetricSnapshot {
  readonly name: string
  readonly kind: MetricKind
  readonly labels: Readonly<Record<string, string>>
  readonly value: number   // counter total / gauge current / histogram sum
  readonly count?: number  // histogram only
  readonly p50?: number    // histogram only
  readonly p95?: number    // histogram only
  readonly p99?: number    // histogram only
}

const defaultMetricsRegistry = (opts?: {
  sink?: MetricSink              // wired ⇒ each record → sink.send(sample); absent ⇒ snapshot-only
  now?: () => number             // injected clock; default Date.now
  histogramBuckets?: ReadonlyArray<number>  // reserved for future bucketed exposition
  histogramMaxObservations?: number          // exact histogram retention cap before bounded sketch compaction
}) => MetricsRegistry
```

2 built-in sinks:
- `consoleMetricsSink` — `[metric] name=X kind=Y val=Z labels={…}` per sample to stderr (local dev)
- `jsonlMetricsSink(path)` — `JSON.stringify(sample) + "\n"` appended; auto-creates parent dir; `flush()` is a no-op (sync write)

## 계약 (6)

1. **PURE STORE**. 인메모리, 0 I/O. 영속화 / export 는 caller 가 wire 한 `MetricSink` 책임.
2. **NAME COMMITS TO KIND on first use**. `gauge("foo", 5)` 후 `increment("foo")` → `MetricsError("name-mismatch-kind")` throw (programmer bug — 두 subsystem 이 같은 metric name 으로 충돌). label 은 kind commitment 에 영향 안 함.
3. **SINK NO-THROW**. `sink.send` 는 try/catch wrap — throwing sink 는 silently swallow. registry 자체는 sample 을 여전히 record. observability 평면이 caller 를 crash 시켜선 안 됨.
4. **SANITIZATION**. negative / non-finite `delta` (counter) / `value` (histogram) 는 silently 0 으로 coerce. gauge 는 negative 허용 (point-in-time signed value — e.g. "free disk delta"). 같은 posture `BudgetMeter.tick`.
5. **BOUNDED HISTOGRAM RETENTION**. histogram 은 `histogramMaxObservations` 까지는 exact observation 배열을 유지하고, cap 초과 시 p50/p95/p99 용 P² sketch 로 compact 한다. `count` / `value(sum)` 는 계속 exact 하며 장수명 프로세스에서도 memory 가 series 당 bounded 다. `histogramBuckets` 는 미래의 bucketed-exposition 모드 (Prometheus `_bucket` series) 를 위해 여전히 reserve.
6. **LABELS sorted lexicographically** before forming series key — `{a:1,b:2}` 와 `{b:2,a:1}` 가 single time-series 로 합쳐짐. 비어있는 labels 는 frozen `{}` 으로 normalize.

## Default-OFF posture

이 슬라이스를 **자동으로 인스턴스화하는 곳 없음**. `sink` 가 absent 면 `send` 는 호출되지 않음 — registry 는 in-process snapshot source 로만 동작. surface (apps/agent bootstrap, future dispatch.ts auto-instrument, future verify-gate counter) 가 opt-in 으로 wire 한다.

`@/observability` 부모 barrel 은 의도적으로 `metrics/` 를 re-export 하지 **않음** — caller 가 `@/observability/metrics` 를 명시적으로 import 해야 한다 (default-OFF 시그널 강화, transient unused import 방지).

## Hellgate (23 cases)

`tests/unit/observability-metrics-hellgate.test.ts` 가 5 section 으로 봉인:

- **A. registry core (8)**: counter increment / accumulation / label split / histogram single + 100 samples / gauge latest-wins / reset (kind commit 해제 포함) / name-kind clash → typed throw
- **B. sink integration (4)**: sink 부재 → no error / wired sink → 1 send/record / throwing sink → registry 여전히 record (no-throw) / `flush()` → `sink.flush()` propagate + sink-without-flush 도 no-op
- **C. built-in sinks (4)**: consoleSink stderr 캡처 / jsonlSink line-per-send + JSON shape / jsonlSink 누락된 parent dir auto-create / jsonlSink `flush()` 는 즉시 resolve (sync write)
- **D. histogram math (5)**: 1 obs → p50=p95=p99=value / 1..100 uniform → p50=50 p95=95 p99=99 (nearest-rank) / label combo distinct bucket / `histogramBuckets` injection 수용 / `histogramMaxObservations` cap 초과 시 count+sum exact 유지 + percentile sketch finite
- **E. edge cases (2)**: negative / NaN / Infinity → 0 coerce / label order normalize

전부 인메모리 + tmpdir (jsonl 4건만 disk I/O, 즉시 cleanup). 23 pass / 0 fail.

## Alternatives rejected

1. **"OTel SDK 직접 dependency"** — `@opentelemetry/api` + `@opentelemetry/sdk-metrics` 는 무겁고 (~5MB), env-coupled (collector endpoint resolution, resource detector, exporter 선택지 다중), 그리고 surface 가 커서 우리 모듈의 plane-clean 위반. 우리는 typed port 를 먼저 봉인하고 미래에 `otelMetricsSink` adapter 로 wrap 한다 (single file, opt-in dependency).
2. **"trace event 를 metric 으로 재사용"** — `AgentEvent` 는 turn-shaped (one event per action), metric 은 series-shaped (aggregation over time + percentile). 같은 wire format 으로 두 의도를 모두 만족시키면 둘 다 약해진다: trace consumer 가 percentile 을 재계산하거나 metric consumer 가 turn boundary 를 알아야 함. 두 surface 는 voice-match (default-OFF, plane-clean) 이지만 도메인이 다르다.
3. **"Prometheus push gateway / pull endpoint 내장"** — exposition format 이 다르고 (`_bucket` series, label cardinality 제어) HTTP server lifecycle 이 따라온다. 본 ADR scope 외 — `prometheusMetricsSink` 로 별도 ADR.
4. **"unbounded exact observation arrays"** — reject. 장수명 daemon 에서는 histogram series 가 무한 성장하고 snapshot 마다 O(n log n) sort 를 강제한다. 현재 adapter 는 exact 초기 구간 뒤 P² sketch 로 compact 해 count/sum exact, percentile memory bounded 라는 절충을 택한다. HdrHistogram / t-digest 는 더 무겁거나 dependency cost 가 커서 현재 scale 에서 ROI 가 낮다.
5. **"counter 가 monotonic 이 아니어도 됨 (signed delta)"** — Prometheus / OTel 둘 다 counter 의 단조 증가를 가정 (rate() 함수가 wrap detection 으로 이를 활용). signed delta 는 사실상 gauge — 우리는 gauge 도 노출하므로 counter 의 의미를 흔들 이유 없음.
6. **"label cardinality DoS guard 내장"** — 본 ADR scope 외. metric name 별 label combination 수 제한은 production posture (예: `tool_calls_total{tool=$random_id}` 같은 cardinality explosion 방지) 이지만 우리는 default-OFF 슬라이스로 시작 — wiring site 가 cardinality 를 결정. follow-up.

## SOTA++ 자리매김

| Agent | typed metric primitive | counter/gauge/histogram 3-arm | label series split | in-process snapshot query | sink adapter (OTel/Prometheus/JSONL) | sink no-throw | name-kind commit |
|---|---|---|---|---|---|---|---|
| Cline | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| Claude Code 2.1 | ❌ (UI totals only) | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| Cursor 3.2 | ❌ (UI panel only) | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| Codex Desktop | partial (per-model OTel) | counter only | ❌ | ❌ (export-only) | OTel only | n/a | n/a |
| v0.dev | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| **quanta (본 ADR)** | ✅ | ✅ 3-arm closed union | ✅ sorted-key normalize | ✅ `snapshot()` | ✅ closed-port + 2 built-in | ✅ try/catch + swallow | ✅ first-use commit + typed throw |

= "Cursor IDE 패널 + Codex OTel breakdown + Claude Code UI totals 가 각각 cover 한 fragment 를 closed-port `MetricSink` + typed `MetricsRegistry` 로 통합한 첫 슬라이스."

## Follow-up (이 ADR 이 닫지 않는 것)

- **`otelMetricsSink` adapter** — `@opentelemetry/api` 를 opt-in dep 으로 추가하고 `MeterProvider.createCounter / createHistogram / createUpDownCounter` 로 mapping. registry → OTel push.
- **`prometheusMetricsSink` adapter** — HTTP `/metrics` endpoint serving exposition format (`# TYPE foo counter\nfoo{tool="bash"} 42`). `histogramBuckets` 가 그때 활성화.
- **auto-instrumentation** — `src/agent/dispatch.ts` 의 LLM stream completion 마다 `tool_calls_total` + `llm_request_duration_ms` 자동 record. `src/agent/verify-gate.ts` 의 pass/fail → `verify_gate_{pass,fail}_total`. `src/agent/loop.ts` 의 turn boundary → `turn_duration_ms` 히스토그램.
- **label cardinality guard** — series cardinality 가 N 을 초과하면 warn / drop / aggregate-into-other 정책. label cardinality explosion 방지.
- **persistence / disk roundtrip** — long-running session 의 snapshot 을 disk 로 round-trip (ADR-0124, ADR-0138 의 `serialize`/`hydrate` discipline 차용). 본 ADR 의 registry 는 in-memory only.
- **strict-mode flag** — `sinkErrorPolicy: "swallow" | "throw"` 옵션 — 일부 caller 는 sink 실패를 loud failure 로 보고 싶을 수 있음. 본 ADR 은 swallow only.
- **`/metrics` CLI 슬래시** — registry snapshot 을 사용자가 직접 보는 view. tier1 builder 가 `cfg.metricsRegistry?` 슬롯이 wired 됐을 때만 tool 노출 (default-OFF).
- **0124/0138/0144 helper-bundle ADR** — 세 슬라이스 모두 helper-only deferred-wire family. 미래에 single helper bundle ADR 로 묶을 가능성 (현재는 각자 default-OFF 이므로 충돌 없음).

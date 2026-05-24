# ADR-0154: OTel `MeterProvider`-backed metric sink — closed-port adapter for production export

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0144 (observability metrics foundation — `MetricSink` 포트, `defaultMetricsRegistry`, consoleSink + jsonlSink)
- **SOTA 출처**: Codex Desktop 의 per-model OTel breakdown (export-only, in-process query API 없음) — 우리는 ADR-0144 의 in-process snapshot 과 본 ADR 의 OTel export 를 동일 registry 한 곳으로 합친다. Cursor 3.2 / Claude Code 2.1 / v0.dev 모두 typed `MetricSink` adapter 없음
- **참조**: `src/observability/metrics/otel-sink.ts`, `src/observability/metrics/index.ts`, `tests/unit/observability-metrics-otel-hellgate.test.ts`, ADR-0144

## 맥락

ADR-0144 가 typed `MetricSink` 포트 + in-memory registry + 2 built-in sink (`consoleMetricsSink`, `jsonlMetricsSink`) 를 봉인했다. follow-up 으로 명시된 `otelMetricsSink` adapter 는 production 배포에서 동일 시리즈를 Prometheus / Grafana / OTel Collector 로 push 할 수 있게 한다.

요구되는 매핑:
- `MetricSample {kind:"counter"}` → OTel `Counter.add(value, attrs)`
- `MetricSample {kind:"histogram"}` → OTel `Histogram.record(value, attrs)`
- `MetricSample {kind:"gauge"}` → OTel `UpDownCounter` (gauge emulation; 아래 §gauge 참조)

posture 는 동일: closed-port, plane-clean (`./port` + OTel 타입만), default-OFF (caller 가 `MeterProvider` 를 build 해 주입).

## 결정

`src/observability/metrics/otel-sink.ts` (단일 파일):

```ts
export interface OtelSinkOpts {
  readonly meterProvider: OtelMeterProvider   // caller-built — Quanta does NOT auto-instantiate
  readonly meterName?: string                 // default "quanta"
  readonly meterVersion?: string              // forwarded to getMeter(name, version)
}

export const otelMetricsSink: (opts: OtelSinkOpts) => MetricSink
```

핵심 결정 3 가지:

### 1. 구조적(structural) OTel 타입 — hard import 회피

`@opentelemetry/api` 를 `package.json` 의 `dependencies` 로 박지 않고, 우리가 호출하는 표면 (`MeterProvider.getMeter`, `Meter.createCounter`/`createHistogram`/`createUpDownCounter`, `Counter.add`, `Histogram.record`, `UpDownCounter.add`, `MeterProvider.forceFlush?`) 만 로컬 `OtelMeterProvider` / `OtelMeter` / `OtelCounter` / `OtelHistogram` / `OtelUpDownCounter` 타입으로 선언한다.

- 실제 `@opentelemetry/api` 의 `MeterProvider` 는 우리 구조 타입에 structurally assignable — caller 가 그냥 wire 하면 그대로 들어맞는다.
- OTel 을 쓰지 않는 surface 는 의존성 / 번들 비용 0 (Default-OFF 의 본질).
- 테스트는 fake 를 만들어 OTel runtime 없이 13 case 를 봉인.

이는 `@opentelemetry/api` 가 stable surface (v1.x 안정) 라 가능한 절충이다. 새 instrument kind (예: `ObservableGauge`) 가 필요해지면 그때 구조 타입 확장 (방향 동일).

### 2. Gauge emulation — `UpDownCounter` + per-(name, labelsKey) prev-value delta

OTel API 는 **synchronous gauge primitive 가 없다**. 선택지:
- `UpDownCounter` + 우리가 prev 를 들고 delta 를 add → 채택. 콜렉터 측의 `UpDownCounter` 누적 합 = 우리 gauge 의 현재값.
- `ObservableGauge` + callback (in-memory registry 를 pull) → 거부. sink 를 registry 에 결합하는 역방향 의존, 그리고 registry 부재 시 ObservableGauge 의 의미가 없어진다.

prev cache 는 `Map<labelsKeyJson, number>` 로 per-name 분리, `in-memory-registry` 의 `labelKey` (sorted-key JSON) 와 alignment 보장.

`delta === 0` 일 때는 `add` 를 호출하지 않는다 (콜렉터의 write 비용 절감, semantically no-op).

### 3. Instrument kind lock — typed warn, no throw

registry 가 이미 ADR-0144 #2 로 one-name-one-kind 를 강제하지만, caller 가 registry 우회로 sink 에 직접 mismatched kind 를 feed 하면 defense-in-depth 로:
- 첫 send 시 결정된 kind 와 mismatch → `console.warn` 으로 typed message ("dropping sample: name X locked to kind Y, got Z") 출력 후 sample drop.
- throw 하지 않는다 (sink no-throw 정책, ADR-0144 #3).

## Hellgate (13 cases)

`tests/unit/observability-metrics-otel-hellgate.test.ts`:

- **A. adapter contract (4)**:
  1. factory → `MetricSink` shape (`send` + `flush`)
  2. `getMeter` lazy — 0 send → 0 call; n sends → 1 call (with meterName)
  3. counter sample → `Counter.add(value, attrs)` with correct args
  4. histogram sample → `Histogram.record(value, attrs)` with correct args
- **B. instrument caching (3)**:
  5. 같은 name 3 sends → `createCounter` 1번
  6. 다른 name → factory 2번 / instrument 2개
  7. 같은 name 다른 kind → typed warn + sample drop + no histogram factory call
- **C. gauge emulation (2)**:
  8. gauge sample → `createUpDownCounter` + `add(initial)` (prev=0)
  9. 연속 gauge update → delta 산술 검증 (10/-3/+5 패턴 + per-labels series 분리 + delta=0 suppression)
- **D. no-throw + flush + labels (4)**:
  10. instrument.add throws → sink no-throw
  11. forceFlush throws → flush resolves; happy-path 도 wired
  12. labels 누락 / `{}` → instrument 에 `attrs=undefined` (OTel "no attributes")
  13. end-to-end via `defaultMetricsRegistry` → 모든 instrument 에 올바르게 도착

13 pass / 0 fail. fake `MeterProvider` 로 OTel runtime 없이 봉인.

## Default-OFF posture

`src/observability/index.ts` 의 부모 barrel 은 **건드리지 않는다**. `@/observability/metrics` 의 sub-barrel 에서만 export — surface 가 명시적으로 import 하고, `MeterProvider` 를 build 해서 (자기 책임 하의 exporter + resource attrs + shutdown) `otelMetricsSink({meterProvider})` 로 wire 한다. 우리 측이 `MeterProvider` 를 만들거나 `forceFlush` lifecycle 을 관리하지 않는다.

## Alternatives rejected

1. **Auto-instantiate `MeterProvider` (e.g. `@opentelemetry/sdk-metrics` 의 `MeterProvider` 를 우리가 new)** — opaque resource lifecycle. 어떤 exporter, 어떤 reader interval, 어떤 resource attrs 를 박을지는 deployment 별 결정. 우리가 default 를 박으면 운영자가 over-ride 하기 어렵다. caller-built DI 가 정답.
2. **Bundle exporters (Prometheus / OTLP / Console) inline** — `@opentelemetry/exporter-prometheus`, `@opentelemetry/exporter-trace-otlp-http` 등은 transport 별 강한 의견 (HTTP server port, OTLP endpoint, batch policy) 을 동반. caller 가 자기 환경에 맞는 exporter 를 OWN 한다.
3. **Direct push (StatsD / Prometheus pushgateway / Datadog API)** — re-implements what OTel already does. OTel collector 가 모든 backend 의 fan-out 을 담당하는 것이 production 표준.
4. **`ObservableGauge` for gauge** — callback 이 in-memory registry 를 pull 해야 함 → sink → registry 역방향 결합. delta-add 가 stateless 하고 OTel 권장 패턴.
5. **`@opentelemetry/api` 를 hard dep 으로 박기** — OTel 안 쓰는 surface 까지 install 부담. 구조 타입 + caller DI 로 회피 (위 결정 §1).
6. **kind mismatch 시 throw** — sink no-throw 정책 (ADR-0144 #3) 위배. registry 가 이미 throw 하므로 sink 는 silent drop + warn 이 옳다 (defense-in-depth).

## SOTA++ 자리매김

| Agent | typed metric primitive | OTel adapter | gauge emulation | kind lock | sink no-throw | caller-owned MeterProvider lifecycle |
|---|---|---|---|---|---|---|
| Cline | ❌ | ❌ | n/a | n/a | n/a | n/a |
| Claude Code 2.1 | ❌ (UI totals only) | ❌ | n/a | n/a | n/a | n/a |
| Cursor 3.2 | ❌ (UI panel only) | ❌ | n/a | n/a | n/a | n/a |
| Codex Desktop | partial (per-model OTel) | export-only (counter only) | n/a | n/a | n/a | n/a |
| v0.dev | ❌ | ❌ | n/a | n/a | n/a | n/a |
| **quanta (ADR-0144 + 본 ADR)** | ✅ 3-arm | ✅ closed-port | ✅ UpDownCounter delta | ✅ defense-in-depth warn | ✅ try/catch + swallow | ✅ caller-built DI |

= "Codex 의 OTel breakdown 은 export-only 였다. 우리는 ADR-0144 의 in-process snapshot 과 본 ADR 의 OTel export 를 동일 registry 한 곳에서 합친다 — operator 가 `/metrics` 슬래시로도 보고, Grafana 대시보드에서도 본다."

## Follow-up (이 ADR 이 닫지 않는 것)

- **OTLP / Prometheus exporter wiring examples** — `docs/examples/otel-collector.md` (또는 surface README) 에 `NodeSDK` + `OTLPMetricExporter` / `PrometheusExporter` 로 `MeterProvider` 를 build 하는 30-line 예시.
- **Auto-shutdown hook integration** — agent shutdown sequence 가 우리 registry 의 `flush()` 를 부르면 자동으로 `meterProvider.forceFlush()` 가 따라가지만, `meterProvider.shutdown()` (collector 연결 정리) 는 caller 책임 — `src/agent/shutdown.ts` (있다면) 에 hook 슬롯 정의.
- **`ObservableGauge` 옵션** — long-lived agent (subagent supervisor) 의 in-process snapshot 을 pull 하고 싶을 때. `otelMetricsSinkObservable(registry, opts)` 형태의 별도 factory 로 가능 (registry → sink 역방향 결합 인지하고 명시적 surface 분리).
- **batch / async-record buffer** — 본 ADR sink 는 synchronous (각 send 가 `.add`/`.record` 즉시 호출). 매우 high-throughput 시리즈에서는 batch buffer 옵션이 필요할 수 있음 — OTel SDK 의 `PeriodicExportingMetricReader` 가 보통 이를 cover 하지만, sink-side buffer 가 필요하면 추가.
- **structured warn → 구조화 로거 wiring** — 현재 kind-lock warn 은 `console.warn`. `StructuredLogger` 가 wired 된 surface 에서는 그쪽으로 우회하는 옵션 (`onKindLock?: (event) => void`) 추가 여지.
- **`@opentelemetry/api` dep 정식 추가** — 본 ADR 은 구조 타입으로 회피. 향후 OTel 이 표준이 되면 hard dep 으로 박고 `import type` 으로 갈아끼우는 1-line PR 가능 (surface 변동 0).

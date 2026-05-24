# ADR-0155: OTLP HTTP + Prometheus exporter wiring helpers — lazy-load + typed deps-missing error

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0154 (OTel `MeterProvider`-backed metric sink — closed-port structural adapter), ADR-0144 (observability metrics foundation)
- **SOTA 출처**: Codex / Claude Code / Cursor / v0.dev 모두 typed `MetricSink` + caller-built `MeterProvider` 패턴 부재; 본 ADR 의 helper 는 그 caller-build 단계를 "1-line wire" 로 압축하면서 default-OFF 를 유지하는 최초 사례
- **참조**: `src/observability/metrics/otlp-helper.ts`, `src/observability/metrics/index.ts`, `tests/unit/observability-metrics-otlp-helper-hellgate.test.ts`, ADR-0154, ADR-0144

## 맥락

ADR-0154 가 `otelMetricsSink({meterProvider})` 를 봉인했다. caller 가 `MeterProvider` 를 만들어서 주입해야 하는데, 운영자가 매번 `@opentelemetry/sdk-metrics` + exporter 패키지를 import 하고 `PeriodicExportingMetricReader` + `MeterProvider` 보일러플레이트를 직접 짜는 것은 30 줄짜리 마찰이다. follow-up §1 에 명시된 "OTLP / Prometheus exporter wiring examples" 항목을 helper module 로 격상한다.

요구되는 운용 형태:

```ts
// 운영자 1 줄 (OTLP HTTP 푸시)
const { sink, shutdown } = await otlpHttpMetricSink({ endpoint, headers })
const registry = defaultMetricsRegistry({ sink })

// 종료 시
await registry.flush()
await shutdown()
```

posture 는 동일:
- **closed-port** — 2 개 factory 가 같은 `HelperResult` 반환 (`{sink, shutdown}`).
- **plane-clean** — `otlp-helper.ts` 는 `./port` + `./otel-sink` 만 import.
- **default-OFF** — `@opentelemetry/*` 패키지는 `dependencies` 에 박지 않음. helper 호출 시점에 동적 import.

## 결정

`src/observability/metrics/otlp-helper.ts` (단일 파일) + barrel 5 줄 re-export:

```ts
export const otlpHttpMetricSink: (opts?: OtlpHelperOpts) => Promise<HelperResult>
export const prometheusMetricSink: (opts?: PrometheusHelperOpts) => Promise<HelperResult>
export class OtelDepsMissingError extends Error { readonly packages: ReadonlyArray<string> }
```

핵심 결정 3 가지:

### 1. Lazy dynamic import + typed `OtelDepsMissingError`

`@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-prometheus` 3 패키지는 `package.json` 에 없다. helper 호출 시점에 `await import(specifier)` 를 패키지별로 독립 try/catch 하고, **누락된 모듈을 모두 모아** `OtelDepsMissingError(packages)` 를 단일 throw 한다.

- 운영자가 한 번에 모든 누락 모듈을 보고 `bun add ...` 한 줄로 해결할 수 있다 (consecutive throw 회피).
- `error.message` 는 `Install with: bun add ...` 힌트를 박는다 (운영 마찰 최소화).
- top-level `import` 으로 박지 않기 때문에 OTel 안 쓰는 surface 의 module evaluation 비용 0.

### 2. 2 factory — OTLP HTTP (push) + Prometheus (passive scrape)

가장 흔한 2 transport 를 한 helper 모듈에 묶었다:
- `otlpHttpMetricSink` — Honeycomb / Grafana Cloud / OTel Collector 푸시.
- `prometheusMetricSink` — Prometheus 가 scrape 하러 오는 HTTP 서버.

OTLP gRPC, StatsD, Datadog API 등은 follow-up. 운영 현장의 80/20 cover.

### 3. Test seam `__loader` — node_modules 없이 hellgate

`Opts` 에 `__loader?: () => Promise<{...modules}>` 내부 옵션을 노출. 표면 코드는 절대 set 하지 않는다 (default loader 가 실제 dynamic import). hellgate 가 fake SDK modules 를 주입해 OTel runtime 없이 8 case 를 봉인.

`mock.module` 대신 loader 주입을 채택한 이유: ADR-0154 가 `otelMetricsSink` 를 caller-built MeterProvider 로 받는 구조라, helper 도 같은 DI 패턴이 자연스럽다 (`__loader` 가 SDK 의 DI 슬롯).

## Hellgate (10 cases, ≥8 요구 충족)

`tests/unit/observability-metrics-otlp-helper-hellgate.test.ts`:

- **A. OtelDepsMissingError surface (3)**:
  1. default loader (deps 미설치) → `OtelDepsMissingError` reject.
  2. `error.packages` 가 누락 모듈 2 개 (sdk-metrics + otlp-http) 모두 포함.
  3. `error.message` 가 `bun add` 힌트 + 두 패키지 이름 포함.
- **B. with injected loader (7)**:
  4. 성공 construction → `{sink, shutdown}` 반환, `MeterProvider({readers:[reader]})` 1 회 호출.
  5. `shutdown()` → `MeterProvider.shutdown()` 호출 propagation.
  6. endpoint 기본값 = `http://localhost:4318/v1/metrics`; headers 미지정 → `undefined`; interval 기본 5000ms.
  7. custom endpoint + headers + intervalMs 가 `OTLPMetricExporter` ctor + reader 에 정확히 전달.
  8. resource attrs 기본 = `{"service.name":"quanta"}` (Resource ctor 부재 시 plain attrs 객체).
  9. `prometheusMetricSink` default loader → `OtelDepsMissingError` 가 sdk-metrics + exporter-prometheus 2 개 나열.
  10. `prometheusMetricSink` injected loader → `PrometheusExporter({port, endpoint})` ctor 호출 + `MeterProvider({readers:[exporter]})` + shutdown propagation.

10 pass / 0 fail. fake loader 로 OTel runtime 없이 봉인.

## Default-OFF posture

- `package.json` 의 `dependencies` 에 `@opentelemetry/*` **하나도 추가하지 않음**.
- 부모 barrel `src/observability/index.ts` 는 본 모듈을 노출하지 않음 (ADR-0154 와 동일 — sub-barrel `@/observability/metrics` 에서만 export).
- 운영자가 `bun add @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http` 하고 `otlpHttpMetricSink()` 호출할 때 비로소 SDK 가 메모리에 올라간다.
- helper 가 throw 한 `OtelDepsMissingError` 는 startup 의 일부가 아닌 surface-level wiring 의 오류 — 운영자가 받는 한 번의 명확한 메시지.

## Alternatives rejected

1. **OTel SDK 를 `dependencies` 로 박기** — OTel 안 쓰는 surface 까지 install / bundle / startup 비용. ADR-0154 가 구조 타입으로 분리한 의도와 정확히 반대.
2. **누락 시 helper 가 silent fallback (예: console sink 로 degrade)** — observability 가 silently 깨지는 것이 가장 나쁜 운영 사고. typed throw 가 옳다.
3. **runtime 자동 install (`npm install ...` 호출)** — security / license 자세 위배. quanta 는 운영자 명시 동의 없이 의존성을 늘리지 않는다.
4. **eager top-level import + try/catch** — `import` 실패가 module evaluation 을 깨거나 (CJS 호환성), import 가 성공한 줄 알았는데 actually undefined 인 silent broken state 를 만든다. 동적 import + per-package try/catch 가 명시적이다.
5. **mock.module 로 hellgate** — bun test 의 mock.module 은 이 helper 가 `await import(...)` 하는 specifier 와 hoist 순서가 잘 맞지 않을 수 있고, 무엇보다 `__loader` 가 더 명시적인 DI 슬롯이다 (ADR-0154 의 `meterProvider` 주입과 같은 패턴).
6. **OTLP gRPC, StatsD, Datadog 도 같이 박기** — 운영자 80/20 미만의 transport. 본 ADR 의 패턴 (lazy import + typed error) 을 follow-up 에서 정확히 같은 모양으로 복제 가능.

## SOTA++ 자리매김

| Agent | typed metric primitive | OTel structural sink | 1-line OTLP wire | typed deps-missing error | default-OFF (zero dep) |
|---|---|---|---|---|---|
| Cline | ❌ | ❌ | ❌ | ❌ | n/a |
| Claude Code 2.1 | ❌ | ❌ | ❌ | ❌ | n/a |
| Cursor 3.2 | ❌ | ❌ | ❌ | ❌ | n/a |
| Codex Desktop | partial | export-only | ❌ | ❌ | ❌ (eager dep) |
| v0.dev | ❌ | ❌ | ❌ | ❌ | n/a |
| **quanta (ADR-0144 + 0154 + 본 ADR)** | ✅ 3-arm | ✅ closed-port | ✅ 2 helpers | ✅ `OtelDepsMissingError(packages)` | ✅ zero `@opentelemetry/*` dep |

= "Codex 는 OTel SDK 를 eager dep 으로 박았다. quanta 는 typed `OtelDepsMissingError` + lazy import 로 OTel 안 쓰는 운영자의 install / bundle / startup 비용을 0 으로 유지하면서, OTel 쓰는 운영자에게는 1-line wire 를 제공한다."

## Follow-up (이 ADR 이 닫지 않는 것)

- **OTLP gRPC exporter** — `@opentelemetry/exporter-metrics-otlp-grpc` (또는 proto). 본 ADR 의 패턴 그대로 `otlpGrpcMetricSink` 1 factory 추가.
- **StatsD exporter** — `@opentelemetry/exporter-metrics-otlp-proto` 또는 별도 StatsD sink (typed deps-missing 패턴 동일).
- **환경변수 자동 감지** — `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_RESOURCE_ATTRIBUTES` 표준 envvar 가 set 되면 helper 호출 측에서 자동으로 endpoint / headers / resourceAttrs 를 채워주는 surface 옵션 (`auto: true`).
- **Agent shutdown hook 자동 wiring** — `apps/agent` bootstrap 이 `shutdown()` 을 process exit handler 에 등록하는 surface helper (`registerOtelShutdown`).
- **`@opentelemetry/api` peer dep 명시** — 본 ADR 은 구조 타입 + dynamic import 로 회피. OTel 사용이 표준화되면 `peerDependencies` 로 명시 (caller install 강제하지 않으면서 typed peer 관계만 선언).
- **Resource detector 통합** — `@opentelemetry/resources` 의 `processDetector` / `envDetector` 자동 감지 옵션 (현재는 plain attrs object 만).

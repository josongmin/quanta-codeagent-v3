# ADR-0163: OTel Resource attribute auto-enrichment — opt-in helper for OTLP / Prometheus sinks

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0155 (otlp-helper lazy-load + typed deps-missing), ADR-0154 (OTel structural sink), ADR-0144 (observability metrics foundation), ADR-0161 (monitoring full coverage)
- **참조**: `src/observability/metrics/otel-resource.ts`, `src/observability/metrics/otlp-helper.ts`, `tests/unit/otel-resource-hellgate.test.ts`
- **번호 공존 노트**: 본 ADR 은 `0163-foundry-future-ready.md` 와 동일 번호를 공유한다 (parallel-track 흡수에서 ADR drift). `0155-mcp-skybridge.md` / `0155-otlp-helper.md` 와 동일한 conventional dual-key 패턴.

## 맥락

ADR-0155 의 `otlpHttpMetricSink({resourceAttrs})` 기본값은 `{"service.name":"quanta"}` 한 줄뿐이다. 운영 환경에서 collector / Grafana / Honeycomb 가 instance / version / environment 단위 그룹·필터·알람을 걸려면 OTel semconv 의 정체성 attribute 셋이 필요하다:

- `service.instance.id` (`${hostname}-${pid}`)
- `service.version` (`package.json` 의 version)
- `deployment.environment` (`prod` / `staging` / ...)
- `host.name`
- `process.pid`
- `process.runtime.{name,version}`

운영자가 매번 이 6 attribute 를 직접 채워서 `resourceAttrs` 에 박는 마찰을 helper 1 줄 + opt-in 플래그로 제거한다. ADR-0155 의 follow-up §"Resource detector 통합" 을 closes.

## 결정

`src/observability/metrics/otel-resource.ts` — 단일 pure helper:

```ts
export const buildOtelResourceAttrs: (opts?: ResourceAutoOpts) => Record<string, string>
```

`otlp-helper.ts` 의 `OtlpHelperOpts` / `PrometheusHelperOpts` 에 opt-in 플래그 1 개 추가:

```ts
readonly autoResource?: ResourceAutoOpts | boolean
```

- `autoResource: true` → `buildOtelResourceAttrs()` 기본값 사용.
- `autoResource: <obj>` → 그 opts 전달.
- `autoResource` 미지정 → 기존 `resourceAttrs ?? {"service.name":"quanta"}` 그대로 (byte-identical, ADR-0155 caller 0 회귀).
- 두 옵션 모두 지정 시 → `resourceAttrs` 가 caller-explicit 이므로 auto 위에 spread (HELL-C10 외 미적용).

### 자동 감지 우선순위

| Attribute | priority |
|---|---|
| `service.name` | `opts.serviceName` ▷ `env.QUANTA_SERVICE_NAME` ▷ `"quanta"` |
| `service.instance.id` | `${hostnameFn()}-${pidFn()}` |
| `service.version` | `opts.serviceVersion` ▷ `env.QUANTA_VERSION` ▷ sibling `package.json` 의 `version` ▷ `"0.0.0"` |
| `service.namespace` | `env.QUANTA_NAMESPACE` ▷ **OMITTED** (synthetic empty value 회피) |
| `deployment.environment` | `opts.deploymentEnv` ▷ `env.QUANTA_DEPLOYMENT_ENV` ▷ `"unknown"` |
| `host.name` | `hostnameFn()` |
| `process.pid` | `String(pidFn())` |
| `process.runtime.name` | `globalThis.Bun` 있으면 `"bun"`, 아니면 `"node"` |
| `process.runtime.version` | `process.versions.bun` ▷ `process.versions.node` |
| `opts.extra.*` | 항상 LAST — 모든 auto-detected attr override |

### Plane-clean

`otel-resource.ts` 는 `node:os` + `node:fs` + `node:path` 만 import. NO `@/agent`, `@/llm`, `@/tool`. `package.json` 읽기는 `readFileSync` 동기 (Part-1 contract 가 `(opts?) => Record<string,string>` 동기 반환이라 `fs/promises` 는 호환 불가능 — 명세의 "fs/promises (optional)" 표기는 sync 함수 시그니처와 충돌하므로 `fs` sync 로 deviate, ADR 본문에 명시).

### Test seam

`hostnameFn` / `pidFn` / `env` 3 개 주입 슬롯으로 `process.env` / `os.hostname()` / `process.pid` 를 우회 — hellgate 는 zero real-process-state 의존성으로 봉인.

## Hellgate (10 cases)

`tests/unit/otel-resource-hellgate.test.ts`:

- **A. Pure function (6)**
  1. empty opts → `service.name="quanta"`, `service.instance.id` ends with `-${pid}`, runtime name in `{bun,node}`.
  2. `opts.serviceName` overrides env + default.
  3. `env.QUANTA_VERSION` populates `service.version`.
  4. `opts.deploymentEnv` overrides env.
  5. `opts.extra.host.name` overrides auto-detected `host.name`.
  6. `service.namespace` 키가 결과 객체에 **존재하지 않음** (`"service.namespace" in result === false`).
- **B. Test seams (2)**
  7. `hostnameFn` + `pidFn` → `service.instance.id` deterministic.
  8. env injection → `service.version` + `service.namespace` 두 필드 동시 채움.
- **C. Integration (2)**
  9. `otlpHttpMetricSink({__loader, autoResource: true})` → `MeterProvider` ctor 가 enriched attrs 수신.
  10. `otlpHttpMetricSink({__loader})` (no `autoResource`) → resource = `{"service.name":"quanta"}` byte-identical.

10 pass / 0 fail. ADR-0155 의 `observability-metrics-otlp-helper-hellgate.test.ts` 10 case 도 byte-identical 보장 (`autoResource` 미지정 경로) — 0 regression.

## Alternatives rejected

1. **`@opentelemetry/resources` 의 `Resource.default()` + `processDetector` / `envDetector` 직접 사용** — heavy dep, ADR-0155 의 default-OFF 자세 위배. 본 helper 는 `node:os` + `node:fs` 만으로 같은 attribute 셋을 채운다.
2. **`@opentelemetry/resource-detector-*` (k8s / aws / gcp) 패키지 흡수** — surface 별로 운영자가 직접 골라 install. 본 ADR 의 패턴 (opt-in flag + pure helper) 을 그대로 복제 가능 (`autoResource: { detector: "k8s" }` 등).
3. **`autoResource` 를 default ON** — ADR-0155 caller 0 회귀 보장 위배. opt-in 으로 byte-identical 유지.
4. **`fs/promises` async helper** — Part-1 contract 가 `Record<string,string>` 동기 반환. async 로 바꾸면 `otlpHttpMetricSink` 의 `resolveResourceAttrs` 도 async chain — 호출자 ergonomics 손상.
5. **`service.namespace` 를 `""` 로 emit** — 운영자가 명시적으로 set 한 namespace 와 absent 를 구분할 수 없게 됨 (synthetic empty dimension). 키 OMIT 이 옳다.
6. **`process.versions` 를 그대로 dump** — `node` / `bun` / `v8` / `openssl` 등 십수 개 키를 attr 로 박으면 cardinality / 비용 폭증. runtime name + version 2 개만 추출.

## Follow-up

- **k8s.* / container.* semconv** — `KUBERNETES_*` env / `/proc/1/cpuset` 기반 자동 감지 helper (`buildOtelK8sAttrs`). 본 ADR 과 같은 패턴.
- **OTel std env vars** — `OTEL_RESOURCE_ATTRIBUTES="key1=v1,key2=v2"` 표준 envvar 자동 파싱 (현재는 `QUANTA_*` 만).
- **`cloud.provider` / `cloud.region`** — AWS / GCP / Azure metadata service ping (네트워크 I/O 발생하므로 sync API 와 incompatible — async sibling helper `buildOtelCloudAttrs` 로 분리).
- **`telemetry.sdk.*`** — quanta 의 자체 SDK 버전 attribute (`telemetry.sdk.name=quanta`, `telemetry.sdk.version=<package.json version>`) — 본 ADR 의 다음 minor 에서 추가.

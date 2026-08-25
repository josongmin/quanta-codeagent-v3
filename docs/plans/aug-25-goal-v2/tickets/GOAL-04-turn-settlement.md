# GOAL-04 — turn settlement: 실제 usage 정산, receipt-before-persist, outcome SSOT

**Priority:** P0 · **Depends on:** GOAL-03 · **크기:** 40+ tool-use, main-direct

## 목적
objective budget을 모델 자기보고가 아니라 host가 측정한 실제 token/turn으로 정산하고, progress receipt를 persistTurn **앞**에서
authority에 commit해 "완료 turn 직후 종료해도 마지막 receipt가 있는" 상태를 만든다. outcome 분류는 기존 stop taxonomy를 재사용한다.

## 작업명세
### 파일
- `src/host/runtime/internal/context-binding/turn-runner.ts` (`runRuntimeTurn`)
  - 인자 `objectiveAttempt?: { threadId; objectiveId; objectiveRevision; attemptId; source: "goal-continuation" | "foreground" }`.
  - 순서: `runAgent` → (GOAL-03) 소스 digest 재비교 → `settleAttempt` commit → `buildObjectiveSnapshotProvider`로 **정산 후** snapshot → `persistTurn`.
  - persist 실패: `authority.restore(prior, settledRevision)`(CAS) → 실패면 `decision-counter` critical + throw(세션 계속 진행 금지).
- `src/objective/core-store/*` `settleAttempt` 핸들러(GOAL-01에서 타입만):
  ```ts
  interface ObjectiveAttemptSettlement {
    objectiveId: string; attemptId: string; startedRevision: number
    tokensUsed: number; turnsUsed: 1; outcome: ProgressTurnOutcome; executionMode: "foreground" | "background"
    criterionIdsBefore: readonly string[]; verifierReceiptIdsBefore: readonly string[]; recordedAt: number }
  ```
  authority: objectiveId 일치, attemptId 중복 거절, budget tokens/turns 증가(1회), transition/verifier delta 계산, `appendProgressReceipt`, revision +1. actor `system`만.
- usage 측정: `args.base.budgetMeter`(`context-binding/base.ts:339`) `snapshot()` before/after delta. meter 부재 시 agent 이벤트 accumulator fallback(테스트/legacy만). goal enabled면 meter 필수 — composition invariant(`goal-compose-wiring-hellgate`).
  **선행 측정**: OpenAI/Anthropic 어댑터의 usage 이벤트에서 reasoning token이 output에 포함되는지 cassette 1개씩 확인 후 합산식 고정(이중합산 금지).
- outcome: `src/agent/stop-category.ts:522 stopCategoryForReason` 재사용. `ProgressTurnOutcome`을 `completed | aborted | refusal | budget_exhausted | usage_limited | awaiting_approval | max_turns | error`로 확장. `executionMode` 분리.
- `src/apps/cli/repl/objective-progress.ts` — `finishObjectiveProgress` 삭제(runtime으로 이동). `beginObjectiveProgress`는 `objectiveAttempt` 생성기로 축소:
  attemptId = `activeTurnRef.current.currentTurn.turnId`(continuation은 queued attemptKey), 시간은 injected clock. `Date.now()` 0회.
- `src/apps/cli/repl/session-loop/interactive-loop.ts` — 199-216·267의 finish 호출 제거; bg/fg 모두 runtime이 정산. `objectiveAttempt`를 dispatch 인자로 전달.
- foreground 일반 질문: settlement는 항상 commit하되(비용은 objective 비용) receipt는 `criterionTransitions`·`verifierReceiptRefs`가 비고 outcome이 completed면 **생략**(retry/hysteresis attempt 카운트에 안 들어감). 기준을 코드 주석 SSOT로.
- 하드캡은 **GOAL-06 소유**(knob 정의·`budget_limited` 파생·RED 모두). 이 티켓은 `turnsUsed` 정확 카운트만 보장한다.
- 기존 task budget 프롬프트 연결: `src/agent/budget/task-budget.ts:89 renderTaskBudgetBlock`에 objective budget(tokens/turns used/max)을 입력으로 합쳐 **한 블록**으로 렌더. 두 번째 budget renderer 금지.
- `src/objective/pursuit-prompt.ts:39,60` — 내부 `lastAttemptKey`를 모델에 노출하지 않음(제거). `lastTurnOutcome`·verified/remaining ID만 유지. `goal-pursuit-prompt-hellgate.test.ts` 갱신.

## RED
`tests/unit/objective/progress-receipt.test.ts`, `persistence-roundtrip.test.ts`, 신규 `tests/unit/objective/settle-attempt.test.ts`, `tests/unit/host/turn-runner-objective-settlement.test.ts`, `tests/unit/apps/cli/objective-progress.test.ts` 축소
1. 모델이 usage 도구를 0회 호출해도 turn 후 `budget.tokensUsed > 0`, `turnsUsed === 1`.
2. 같은 attemptId로 두 번 settle → 두 번째 거절, revision 불변.
3. objectiveId 불일치(turn 중 edit) → settle 거절, 새 objective의 receipt 0.
4. persistTurn이 throw → authority가 settle 전 revision으로 복귀, receipt 없음.
5. persist된 snapshot(`SavePayload.objectiveSnapshot`)에 **그 turn의 receipt가 포함**됨(before: 미포함).
6. verifierReceiptIdsBefore에 있던 receipt는 `verifierReceiptRefs`에 없음(delta만).
7. attemptId가 wall-clock에 의존하지 않음(clock 두 값으로 동일 key).
8. 일반 foreground 질문(objective delta 0, completed) → receipt 미생성, 비용은 증가.
9. outcome 매핑: StopReason 전값 → ProgressTurnOutcome `Record` + drift-guard.
10. backgrounded turn → `executionMode:"background"` receipt 1개(fg 경로 0개).
11. 프롬프트 스냅샷에 `attemptKey`/`foreground:` 문자열 0(red-on-injection: 노출 복원 mutant에서 RED).
12. `renderTaskBudgetBlock` 출력에 objective budget 포함, 별도 렌더 함수 export 0(arch grep).
13. red-on-injection: settle→persist 순서를 뒤집은 mutant에서 테스트 5 RED.

## E2E
- `tests/integration/goal-continuation-live-e2e.test.ts`: continuation 1회 후 세션 kill → 재기동 → `/goal`이 `last attempt`와 `budget: 1/N turns` 표시.
- PTY: `/goal budget --max-turns=2` → 2회 wake 후 `budget_limited`, 3번째 wake 0(quiet 3배 대기).
- `tests/integration/objective-budget-enforce-e2e-hellgate.test.ts` 갱신(모델 recordUsage 기반 → 실측 기반).

## Proof rails
GOAL-03 rail + `bun test tests/unit/host tests/integration/objective-budget-enforce-e2e-hellgate.test.ts tests/integration/objective-usage-limited-429-real-loop-e2e.test.ts`.

## 함정
- `objective-usage-limit-wire.ts`(429→usage_limited)는 별도 기계 — settlement가 이걸 덮어쓰지 않게 `markUsageLimited`는 그대로 system actor 유지.
- `turn-runner.ts`는 217줄, god-fn 150 라쳇: 정산은 `objective-settlement.ts` helper로.

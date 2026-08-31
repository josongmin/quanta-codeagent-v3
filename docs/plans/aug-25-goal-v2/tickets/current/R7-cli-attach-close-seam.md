# R7 — CLI attach/close wake seam cleanup

**Status:** READY · **Priority:** P2 · **Owner:** CLI session lifecycle

## 목적

이미 작동하는 attach cancellation을 유지하면서 dead quiescence truth를 제거하고, close 시작 이후
goal continuation dispatch가 발생할 수 있는 짧은 teardown window를 닫는다.

## 현재 사실

- attach start는 transcript load 전에 `wake.onActivity()`를 호출해 pending timer를 cancel한다.
- attach success는 `wake.onAttach(newThreadId)`, 실패는 `wake.onGoalMutation()`으로 rearm한다.
- dequeue는 objective identity/revision/activity epoch/attach generation을 재검증한다.
- `armGoalWake.attachingOrClosing` optional callback은 production caller가 넘기지 않아 항상 false다.
- closeStack은 LIFO라 session close 전 wake를 stop하지만, interactive `finally` 진입과 실제 disposer 실행
  사이에는 다른 cleanup이 존재할 수 있다.

## 확정 결정

- 새 lifecycle cell을 만들지 않는다.
- attach truth는 existing `onAttachStart/onAttachSettled` hooks 하나로 유지한다.
- dead `attachingOrClosing` callback과 quiescence field를 삭제한다.
- close truth는 interactive branch `finally` 첫 동작에서 wake를 동기 stop하는 것으로 고정한다.
- closeStack stop은 idempotent cleanup과 slot clear를 위해 유지한다.

## 구조 작업

1. `GoalQuiescenceSnapshot.attachingOrClosing`과 `armGoalWake` optional argument를 제거한다.
2. `runInteractiveBranch` teardown 진입 즉시 current wake를 stop한다. background warning이나 await보다 앞선다.
3. closeStack disposer가 같은 handle을 다시 stop하고 slot identity가 맞을 때 clear하도록 유지한다.
4. attach core의 `finally`-based settled callback과 CLI success/failure mapping을 paired test로 고정한다.
5. queued callback이 timer clear 실패 후 실행돼도 generation/stopped fence로 body 0을 증명한다.

## 예상 write set

- `src/apps/cli/repl/goal-quiescence.ts`
- `src/apps/cli/repl/session-loop/interactive-setup.ts`
- `src/apps/cli/repl/session-loop/interactive-branch.ts`
- branch context/deps if a stop seam must be threaded
- attach/session-switch/wake owner tests

## RED rails

1. attach load/replace/commit/repoint 전 구간 continuation dispatch 0.
2. attach success → old claims cleared, B rearm 1.
3. attach failure/unknown/refusal → parent rearm 1, identity unchanged.
4. close-start 직후 stale timer callback → enqueue/body 0.
5. timer clear throw → stopped generation fence가 callback을 무효화.
6. attached objectiveId/revision/attachGeneration mismatch → dequeue body 0.

## DoD

- dead callback/field가 repo에서 0 references.
- attach와 close 각각 한 개의 실제 lifecycle truth source만 가진다.
- close 시작 이후 async cleanup 길이와 무관하게 goal dispatch 0.

## 중단 조건

- attach hooks와 별도 boolean cell을 동시에 authority로 유지하는 경우.
- closeStack 순서만 근거로 close-start fence를 주장하는 경우.
- user draft/queued user input을 attach safety를 위해 삭제하는 경우.

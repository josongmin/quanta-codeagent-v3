# R2 — Read-time current-source freshness on CLI and web

**Status:** READY · **Priority:** P1 · **Depends on:** R1 receipt contract
· **Owner:** ObjectiveVerificationPort + surface adapters

## 목적

검증 뒤 workspace가 외부에서 바뀌었을 때 다음 attributed turn을 기다리지 않고 CLI/web read가
stale checked completion을 현재 증거로 표시하지 않게 한다.

## 현재 사실

- `ObjectiveVerificationPort.reconcile(threadId)`는 precheck cache, full digest, bounded CAS invalidation을
  이미 구현한다.
- production caller는 `settleObjectiveAttempt()` 한 곳뿐이다.
- CLI `/goal show`는 동기 `control.read()`만 호출한다.
- web `goal` readout accessor도 동기 domain read다.
- runtime facade에는 `objectiveVerifier`가 이미 노출돼 있다.

## 구조 작업

1. CLI `GoalControl`에 `reconcileAndRead()` async operation을 추가한다.
2. `/goal`/`/goal show`는 reconcile 후 다시 읽은 domain과 freshness outcome을 렌더한다.
3. web `WebReadoutSources.goal`을 async accessor로 확장하고 existing verifier를 조립한다.
4. canonical structured Goal payload에 closed freshness view를 추가한다.
   - `fresh`
   - `invalidated`
   - `source-unavailable`
   - `cap-exceeded`
   - `freshness-unresolved`
5. unresolved 상태에서 checked completion/completed badge를 current proof로 렌더하지 않는다. domain
   receipt를 임의 삭제하거나 surface가 completion을 다시 계산하지 않는다.
6. reconcile invalidation이 authority revision을 움직이면 CLI/web wake owner에 `onGoalMutation` edge를
   전달해 active goal을 재무장한다.
7. readout source throw는 HTTP 500 또는 stale success가 아니라 typed unresolved payload가 된다.

## 예상 write set

- `src/apps/cli/slash/objective.ts`
- `src/apps/cli/slash/goal-cmd.ts`
- `src/apps/cli/slash/goal-render.ts`
- `src/apps/web-daemon/readout-compose.ts`
- `src/apps/web-daemon/readout.ts`
- `src/apps/web-daemon/goal-wake-compose.ts`
- `src/protocol/readout/goal.ts`
- generated frontend readout types와 decoder tests

## RED rails

1. verify 성공 → source edit → 추가 turn 없이 CLI show → verified/completed 표시 제거.
2. 동일 시나리오 `GET /readout/goal`.
3. unchanged precheck → full capture 호출 0.
4. source unavailable/cap exceeded → success/completed 주장 0.
5. invalidation revision bump → wake rearm 정확히 1.
6. CLI/web가 동일 authority revision과 freshness outcome을 관측.
7. rendered goal text를 digest/freshness 판단에 사용하면 structural guard RED.

## DoD

- 모든 operator read surface가 canonical reconcile을 통과한다.
- stale receipt는 다음 turn 없이 invalidated되고 goal이 다시 추구 가능하다.
- unresolved evidence는 사용자에게 구분되어 보이고 완료로 승격되지 않는다.

## 중단 조건

- frontend 또는 CLI가 source manifest/digest를 재구현하는 경우.
- reconcile 결과를 무시하고 domain의 기존 `met`만 렌더하는 경우.
- read가 별도 completion authority가 되는 경우.

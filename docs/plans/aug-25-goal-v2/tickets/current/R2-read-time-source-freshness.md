# R2 — Read-time current-source freshness on CLI and web

**Status:** DONE · FINAL PROMOTION GREEN · **Priority:** P1 · **Depends on:** R1 receipt contract
· **Owner:** ObjectiveVerificationPort + surface adapters

## 목적

검증 뒤 workspace가 외부에서 바뀌었을 때 다음 attributed turn을 기다리지 않고 CLI/web read가
stale checked completion을 현재 증거로 표시하지 않게 한다.

## 구현 결과

- `reconcileObjectiveRead()`가 verifier reconcile과 post-reconcile authority read를 하나의 canonical
  operation으로 묶고, verifier 부재/예외도 `freshness-unresolved`로 닫는다.
- CLI `/goal`과 `/goal show`는 `GoalControl.reconcileAndRead()`를 거쳐 freshness를 렌더한다.
- web goal accessor는 async reconcile을 수행하고 canonical structured payload에 closed freshness state를
  싣는다. protocol decoder와 generated frontend type도 동일 필드를 요구한다.
- `fresh`/`invalidated`가 아닌 상태에서는 checked `met`과 completed status를 current proof로 투영하지
  않는다. manual-only objective는 source verifier와 무관한 기존 authority 판정을 유지한다.
- invalidation이 authority revision을 바꾼 경우에만 CLI/web wake owner에 mutation edge를 정확히 한 번
  전달한다.
- browser runtime은 source digest나 completion receipt를 재구성하지 않는다.

## 확정 구조

1. CLI `GoalControl`의 `reconcileAndRead()`가 shared helper를 호출한다.
2. `/goal`/`/goal show`는 reconcile 뒤 authority를 다시 읽고 그 freshness outcome을 렌더한다.
3. web `WebReadoutSources.goal`은 async accessor이며 runtime의 existing verifier를 조립한다.
4. canonical structured Goal payload는 closed freshness view를 필수로 가진다.
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

## 검증 receipt

- source typecheck: PASS
- test typecheck: PASS
- modified-file Biome: PASS (18 files)
- focused R2 host rail: PASS (34 tests, 7 files)
- real Git workspace rails: external edit invalidation, unavailable source masking, unchanged precheck full-capture 0
- structural anti-vacuum rail: canonical CLI/web reconcile live calls + browser digest/completion non-derivation

이 receipt는 R2 branch의 focused closure다. main 통합과 R6 동일-HEAD full gate 전에는 최종 promotion
완료로 간주하지 않는다.

## 예상 write set

- `src/apps/cli/slash/objective.ts`
- `src/apps/cli/slash/goal-cmd.ts`
- `src/apps/cli/slash/goal-render.ts`
- `src/apps/web-daemon/readout-compose.ts`
- `src/apps/web-daemon/readout.ts`
- `src/apps/web-daemon/goal-wake-compose.ts`
- `src/protocol/readout/goal.ts`
- generated frontend readout types와 decoder tests

## 고정된 RED rails

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

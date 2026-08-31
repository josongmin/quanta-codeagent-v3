# R4 — Default-ON web Goal state, wake, freshness, and checkpoint projection

**Status:** FOCUSED GREEN · MAIN INTEGRATION PENDING · **Priority:** P1 · **Depends on:** R2, R7
· **Owner:** goal readout protocol + web daemon/frontend projection

## 목적

운영자가 `/goal` 명령을 입력하지 않아도 브라우저에서 현재 goal, freshness, wake scheduling, 최근
settlement checkpoint를 보고 reconnect 후 같은 상태를 복구하게 한다.

## 완료된 구현

- controller/host/web handle이 injected clock 기반 absolute `wakeAt`과
  `armed|pending|idle|stopped` 상태를 노출한다.
- HTTP `/readout/goal`과 WS `goal.state` push는 `toGoalReadoutData()` 하나를 사용해 revision,
  freshness, wake, `progressReceipts.at(-1)` settlement summary를 투영한다.
- daemon-owned projection cache는 변경된 canonical payload만 push하고, reconnect socket에는 current
  snapshot을 즉시 replay한다. 별도 completion/settlement authority는 없다.
- mutation, session settlement, attach, wake transition, stop edge가 refresh를 요청한다. unchanged payload는
  JSON canonical dedupe로 frame 0개다.
- frontend `SessionClient`는 typed versioned frame을 decode/cache/replay하고, `GoalStateBar`는
  ObservabilityPane 밖에서 항상 렌더된다. countdown은 absolute time을 client가 계산한다.
- raw attempt ID/key, goal text, objective/check ID를 telemetry label로 추가하지 않았다.

## SSOT 결정

- 새 web settlement sink/store를 만들지 않는다.
- objective domain `progressReceipts`가 settlement SSOT다.
- frontend는 typed projection cache만 소유하며 completion/wake authority가 아니다.
- default-ON Goal UI는 default-OFF observability pane과 분리한다.

## 구조 작업

1. goal wake controller에 injected clock을 사용한 absolute `wakeAt`을 저장하고 status에 노출한다.
2. `WebGoalWakeHandle.status()`와 explicit goal-mutation edge를 노출한다.
3. canonical Goal payload를 다음 축으로 확장한다.
   - objective revision/validation/objective view
   - R2 freshness
   - wake `armed|pending|idle|stopped`, skip reason, `wakeAt/retryAt`, `limitedBy`
   - latest settlement summary; raw attempt ID는 control에 필요한 started attempt 외에는 생략
4. `goal.state` typed snapshot/delta protocol을 만든다. goal mutation, settlement, attach, wake transition,
   stop에서만 push한다.
5. connect/reconnect는 현재 snapshot을 즉시 보낸다. 4Hz countdown frame은 만들지 않고 client가 absolute
   time으로 표시한다.
6. frontend SessionClient에 last snapshot replay와 subscription을 추가하고 App에 persistent Goal surface를
   배치한다.
7. `QUANTA_OBSERVABILITY=off`에서도 Goal surface가 보이는 composition gate를 고정한다.

## 예상 write set

- `src/objective/goal-wake-controller.ts`, `src/objective/goal-wake-host.ts`
- `src/apps/web-daemon/goal-wake-compose.ts`
- `src/protocol/readout/goal.ts` 및 goal-state message codec/generator
- `src/apps/web-daemon/readout.ts`, `readout-compose.ts`, server broadcast composition
- `apps/web-frontend/src/ws/client.ts`, goal state hook/reducer
- `apps/web-frontend/src/App.tsx`와 Goal surface component

## RED rails

1. mutation/settlement/attach/wake/stop 각 edge가 상태 전이를 정확히 한 번 emit.
2. unchanged domain/status는 delta 0.
3. reconnect 직후 command 없이 동일 snapshot 복구.
4. observability OFF + goal ON → Goal surface visible.
5. stale freshness/unavailable가 completed badge로 표시되지 않음.
6. absolute `wakeAt/retryAt`으로 reload 후 countdown 복구.
7. objective/attempt/check ID 및 goal text가 telemetry label에 없음.
8. frontend cache 삭제/재생성 후 authority snapshot과 동일.

## DoD

- `/goal` 없이 live wake/checkpoint/freshness를 볼 수 있다.
- push와 HTTP snapshot이 동일 canonical encoder를 사용한다.
- 별도 browser completion/store가 없다.

## 완료 evidence

- backend focused: **60 pass, 0 fail** (7 files)
- frontend focused: **74 pass, 0 fail** (5 files)
- real daemon/TCP WebSocket: initial snapshot, mutation push, second-client reconnect replay, subsequent
  status push를 live authority against **8 pass, 0 fail**로 고정했다.
- source typecheck, test typecheck, frontend typecheck, protocol generated drift, god-code ratchet,
  lint-debt가 green이다.
- 전체 unit/integration/PTY/smoke promotion은 R6 동일-HEAD gate에서 실행한다.

## 중단 조건

- rendered readout text를 frontend state로 파싱하는 경우.
- observability pane을 default Goal visibility의 유일한 carrier로 사용하는 경우.
- countdown을 위해 고주파 daemon tick을 추가하는 경우.

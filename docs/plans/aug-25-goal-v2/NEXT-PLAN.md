# aug-25 /goal v2 — 현재 잔여 작업 계획

기준: `main` `08fb52c175b0289cb26d794bbab9862851b9904d`, 2026-08-31 KST.

이 문서는 과거 티켓의 미구현 목록을 복사하지 않는다. 현재 코드에서 생산자·소비자·프로덕션
조립·테스트를 다시 확인한 결과만 남긴 실행 계획이다. 과거 결함과 커밋 기록은
[`README.md`](README.md)의 실행 기록과 Git 이력에 보존한다.

## 완료 경계

### 닫힌 범위

- 브라우저 `/goal` 제어는 완료됐다: show/create/work/pause/stop/resume/edit/clear/abandon/
  budget/unblock/criterion add+done/check add/verify.
- 웹 mutation은 structured readout revision, command ID receipt, newer-revision readback을 사용한다.
- 웹 verify는 shared `ObjectiveVerificationPort`를 사용하며 verifier 진입점에서 expected revision을
  다시 확인한다.
- 승인 후 goal turn 재개·재귀속, manual criterion attestation, stuck-attempt abandon, blocker
  unblock, 제품 budget ceiling, CLI settlement checkpoint line은 구현돼 있다.
- 웹 objective mirror의 유령 필드는 제거됐고 현재 wire 필드에 대한 drift hellgate가 있다.
- turn-scoped attempt settlement는 기존 decision stream의 `kind:"objective"` arm으로 계수된다.

### 아직 주장하지 않는 범위

- verifier command의 기본 fail-closed OS sandbox
- source가 turn 사이에 바뀐 직후 모든 read surface가 stale receipt를 즉시 제거한다는 보장
- 모델이 보고한 blocker dependency가 host registry identity에 결합된다는 보장
- 브라우저 always-on 상태에서 wake/checkpoint를 볼 수 있다는 보장
- wake/enqueue/completion/verifier lifecycle 전체의 promotion-grade counters
- Goal 전 기능 PTY/smoke battery, headless/batch autonomous pursuit

## 잔여 작업 요약

| 우선순위 | 티켓 | 현재 사실 | 종료 조건 |
|---|---|---|---|
| P1 | R1 verifier execution posture | exact argv·timeout·env scrub·before/after digest는 있으나 verifier가 `perCallWrap`을 요구하지 않고 웹은 CLI sandbox installer를 호출하지 않는다 | 선택한 sandbox 계약이 production composition과 receipt에 반영되고 no-sandbox arm이 RED/GREEN으로 고정 |
| P1 | R2 read-time source freshness | `reconcile()` production caller는 attributed attempt settlement 한 곳뿐이다 | source drift 후 다음 turn 없이 CLI/web read가 stale completion을 성공으로 표시하지 않음 |
| P1 | R3 blocker dependency authority | attempt ID는 host가 찍지만 dependency identity는 모델의 typed `target.ref` 문자열이다 | host-resolved dependency identity와 occurrence evidence로 3-attempt hysteresis가 결합 |
| P1 | R4 web always-on goal state | `/goal` readout은 완전하지만 `WebGoalWakeHandle`이 `wake.status()`를 노출하지 않고 web settlement sink가 없다 | default goal 설치에서 wake 상태와 최근 checkpoint가 명령 없이 갱신됨 |
| P1 | R5 lifecycle telemetry remainder | settlement allow/ask/deny counter만 존재한다 | wake/enqueue/attempt/completion/verifier 사건이 bounded labels로 집계되고 identifier/text가 label/event에 없음 |
| P2 | R6 PTY + smoke battery | PTY 11개는 boot/persistence/quiescence/checkpoint 중심이며 control/verify/budget/blocker matrix가 빠져 있다 | 실행시간 정책을 고정하고 빠진 public behavior battery와 `tests/smoke/goal` 최소 corpus 추가 |
| P2 | R7 CLI attach/close quiescence seam | `armGoalWake.attachingOrClosing`은 optional이지만 production caller가 넘기지 않는다; attach는 별도 cancellation hook으로 방어한다 | dead slot 제거 또는 실제 lifecycle cell 배선, attach/close 동안 dequeue 0을 owner rail로 증명 |
| P3 | R8 headless/batch pursuit | objective authority는 일부 비대화형 표면에 있으나 autonomous wake production caller는 CLI/web뿐이다 | 제품 요구가 확정되면 headless/batch front door와 bounded pursuit E2E 추가 |

## R1 — verifier execution posture와 receipt provenance

### 현재 근거

- owner: `src/host/runtime/objective-verifier-wire.ts`, `src/runtime/run-argv.ts`,
  `src/objective/criteria/{ports,model,verifier}.ts`.
- `maybeWireObjectiveVerifier()`는 `createObjectiveCheckRunner()`를 무옵션으로 만든다.
- `runArgv()`는 installed sandbox slot 또는 per-call wrapper가 없으면 실행 자체는 계속하며,
  sandbox-status observer가 있을 때만 `no-sandbox-installed`를 보고할 수 있다.
- CLI sandbox installer는 `QUANTA_SANDBOX` 선택에 종속되고 웹 데몬은 그 installer를 호출하지 않는다.
- batch result에는 timeout/duration/stdout·stderr digest가 있지만 persistent completion receipt는
  exitCode/passed/sourceDigest 중심이라 execution posture를 사후 감사할 수 없다.

### 결정 게이트

둘 중 하나를 명시적으로 택해야 한다.

1. **fail-closed verifier sandbox**: checked criterion은 verifier 전용 wrapper가 없으면
   `sandbox-unavailable`로 끝나고 command를 실행하지 않는다.
2. **installed-slot 계약**: 무샌드박스 실행을 허용하되 receipt/result에 `sandboxApplied`, posture,
   runner version을 기록하고 surface가 이를 숨기지 않는다.

기본 권고는 웹/기본-ON goal에서는 1번이다. 선택 전에는 구현하지 않는다.

### RED와 수용조건

- no sandbox installed → command runner 호출 0 또는 선택한 degraded receipt가 정확히 기록된다.
- network/read roots/resource policy가 선택한 profile과 일치한다.
- timeout, cancellation, non-zero exit, sandbox unavailable을 서로 다른 typed outcome으로 보존한다.
- raw stdout/stderr는 영속화하지 않고 digest/length만 남긴다.
- CLI와 웹이 동일 coordinator/posture를 사용한다.

## R2 — read-time current-source freshness

### 현재 근거

- verifier는 run 전후 digest와 atomic receipt commit을 보장한다.
- later drift를 제거하는 `reconcile(threadId)`는 존재하지만 production 호출자는
  `settleObjectiveAttempt()`뿐이다.
- 따라서 검증 뒤 외부 source edit가 발생하고 다음 attributed turn이 없으면 `/goal`과
  ObjectiveCard가 기존 `met` receipt를 계속 표시할 수 있다.
- 과거 frontend의 `verificationState`/`verifiedSourceDigest`는 실제 daemon producer가 없는 유령
  필드였으므로 되살리면 안 된다.

### 설계

- canonical freshness owner는 계속 `ObjectiveVerificationPort.reconcile`이다.
- CLI `/goal show`, 웹 structured goal readout, always-on projection이 같은 reconcile 결과를 소비한다.
- surface마다 source digest를 재구현하거나 rendered text에서 stale을 추론하지 않는다.
- expensive full capture는 기존 precheck cache를 재사용하고, cap/unavailable은 typed 상태로 노출한다.

### RED와 수용조건

- verify 성공 → source edit → 추가 turn 없이 read → criterion이 verified로 표시되지 않는다.
- source unchanged → full manifest 재해시 없이 fresh read.
- source unavailable/cap exceeded → completion으로 승격하지 않고 정직한 freshness 상태를 표시한다.
- CLI와 web readout paired test가 동일한 authority revision을 관측한다.

## R3 — blocker dependency identity authority

### 현재 근거

- `applyBlockerMutation()`은 live `attempts.started.attemptId`를 host에서 읽으므로 모델이 3-attempt
  threshold를 tool-call ID로 위조할 수 없다.
- 하지만 grouping key는 `JSON.stringify([waitingOn, target.kind, target.ref.trim()])`이며
  `target.ref`는 모델 입력이다.
- 즉 동일 의존성을 표현만 바꿔 분산시키거나 서로 다른 의존성을 같은 문자열로 합치는 것을 host가
  판별하지 못한다. occurrence evidence registry도 없다.

### 설계

- 새 parallel blocker store를 만들지 않는다. `ObjectiveAuthority`가 observation/threshold owner로 남는다.
- host adapter가 typed target을 registry/resolver에 조회해 stable dependency ID와 occurrence evidence를
  만든 뒤 authority mutation에 전달한다.
- resolver unavailable은 즉시 blocker 생성이 아니라 typed observation refusal/degraded outcome이다.

### RED와 수용조건

- 같은 registry dependency의 표현 변형 3회 → 정확히 한 blocker.
- 서로 다른 dependencies의 같은 prose → 합쳐지지 않음.
- 같은 attempt의 반복 tool calls → distinct-attempt count 증가 0.
- registry miss/unavailable → 모델 문자열만으로 blocker를 확정하지 않음.
- snapshot rehydrate가 stable dependency/evidence identity를 보존한다.

## R4 — web always-on wake/checkpoint projection

### 현재 근거

- `/goal` HTTP readout은 revision, criteria, budget, last attempt를 제공한다.
- `startGoalWakeController()`는 idle/armed/capped와 `retryAt`/`limitedBy`를 계산한다.
- `WebGoalWakeHandle`은 attach/stop 메서드만 반환해 `wake.status()`를 버린다.
- `objectiveSettlementSink` production 조립은 CLI에만 있고 웹에는 없다.
- ObservabilityPane ObjectiveCard는 `QUANTA_OBSERVABILITY` default-OFF 경로이므로 default-ON goal의
  always-on SSOT로 사용할 수 없다.

### 설계

- existing structured goal contract를 확장하거나 goal 전용 typed push frame을 둔다. agent-state나
  rendered text를 파싱하지 않는다.
- canonical payload: objective revision, wake `idle|armed|capped`, typed skip reason, absolute `retryAt`,
  `limitedBy`, latest settlement checkpoint summary.
- 4Hz delta stream에 countdown tick을 밀지 않는다. absolute `retryAt`으로 client가 표시만 계산한다.
- `QUANTA_OBSERVABILITY`와 무관하게 `QUANTA_GOAL` surface에서 동작한다.

### RED와 수용조건

- goal mutation/turn settlement/attach/stop 각각이 정확히 한 상태 전이를 만든다.
- browser reload/reconnect가 snapshot으로 같은 상태를 복구한다.
- default observability OFF에서도 보인다.
- objective text/attempt ID를 telemetry label로 보내지 않는다.

## R5 — lifecycle telemetry remainder

### 현재 근거

- `emitObjectiveSettlementDecision()`이 attributed attempt settlement를 allow/ask/deny로 계수한다.
- decision sink의 labels는 `{kind,outcome}` closed set이고 identifier를 싣지 않는다.
- wake armed/canceled/skipped, enqueue admitted/rejected, completion refusal, verifier applied/stale는 turn
  밖 사건이라 turn index를 요구하는 `DecisionEvent`에 억지로 넣을 수 없다.

### 설계와 수용조건

- objective slice에는 narrow optional lifecycle sink port만 두고 metrics adapter는 observability owner가 가진다.
- event/label enum을 닫는다. goal text, thread/objective/attempt/check ID는 금지한다.
- sink throw는 authority/wake/verifier 결과에 영향을 주지 않는다.
- OFF arm은 allocation/subscription 없이 기존 동작과 동일하다.
- anti-cardinality test와 producer별 RED-on-removal test를 둔다.

## R6 — PTY와 smoke battery

### 현재 근거

현재 PTY는 command discovery/default-OFF, create/show, autonomous continuation, quiet-window,
draft/foreground/background quiescence, process restart, settlement announcement를 다룬다. 다음 public
행동은 PTY에 없다.

- check add → verify → source freshness
- pause → resume → edit
- `--max-turns=2`/product ceiling 표시와 autonomous stop
- no-progress backoff 증가
- blocker observation 2/3 → 3/3 → unblock
- attach thread B에서 prior wake/identity fencing

### 실행 순서와 수용조건

1. PTY 전체 runtime 목표를 현재 실측으로 재설정한다. 기존 90초 숫자를 검증 없이 유지하지 않는다.
2. raw-mode 고유 행동만 PTY에 두고 daemon/integration으로 가능한 항목은 그쪽으로 내린다.
3. 한 케이스에 여러 failure cause를 숨기지 않는다.
4. `tests/smoke/goal/`에는 최소 default-ON pursuit, checked verification, budget stop corpus를 둔다.
5. 각 rail은 revert/mutant가 해당 케이스를 RED로 만든다는 anti-vacuity 근거를 가진다.

## R7 — CLI attach/close quiescence seam

### 현재 근거와 조치

- `armGoalWake()`는 `attachingOrClosing` callback을 받을 수 있지만 production call은 전달하지 않는다.
- session switch는 `onAttachStart → wake.onActivity()`와 `onAttachSettled → wake.onAttach()`로 timer를
  취소/재무장한다. 따라서 현재 확인된 stale dequeue 결함은 없지만 quiescence snapshot field는 dead다.
- 실제 lifecycle cell을 연결해 attach/close 동안 `isQuiescent=false`를 만들거나, hook 기반 계약이 충분함을
  owner test로 증명하고 dead callback을 삭제한다. 둘을 동시에 truth source로 유지하지 않는다.

수용조건: attach load/commit/repoint 전 구간과 close 시작 이후 continuation dispatch 0, attached
objective identity/revision/attachGeneration 재검증, 실패 attach 후 기존 goal 재무장.

## R8 — headless/batch autonomous pursuit

현재 `startGoalWakeController()` production caller는 interactive CLI와 web daemon이다. headless/batch에
objective authority가 존재한다는 사실은 autonomous pursuit가 있다는 뜻이 아니다. 제품 요구가 확정되기
전에는 기능을 추가하지 않는다. 추가 시 interactive prompt queue를 재사용하지 말고 해당 surface의
host-owned dispatch/admission port, budget, cancellation, persistence E2E를 먼저 정의한다.

## 실행 순서

1. R1 sandbox 계약 결정 및 구현
2. R2 read-time freshness
3. R3 blocker dependency authority
4. R4 web always-on projection
5. R5 lifecycle telemetry
6. R7 quiescence truth-source 정리
7. R6 PTY/smoke battery 확장
8. R8은 제품 요구가 있을 때만

R1/R2/R3은 completion·security authority를 바꾸므로 먼저다. R4/R5는 그 결과를 소비하는 projection이고,
R6은 앞선 계약을 public regression rail로 고정하는 마지막 단계다.

## 공통 중단 조건

- 새 objective store, 별도 browser-only completion authority, rendered-text state parser를 만들려는 경우 중단.
- sandbox/freshness/registry 선택이 정해지지 않았는데 surface부터 구현하려는 경우 중단.
- `ObjectiveAuthority` 외부에서 completion 또는 budget verdict를 직접 쓰려는 경우 중단.
- 테스트가 import/comment/bare identifier만 찾아 revert 후에도 green이면 중단.
- default-OFF observability 기능을 default-ON goal의 유일한 사용자 가시성으로 삼으려는 경우 중단.

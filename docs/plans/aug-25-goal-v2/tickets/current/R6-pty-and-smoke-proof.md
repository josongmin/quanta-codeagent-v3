# R6 — Public PTY, integration, and dedicated Goal smoke proof

**Status:** READY AFTER R1-R5/R7 · **Priority:** P2 · **Owner:** Goal promotion evidence

## 목적

이미 있는 unit behavior를 중복 구현하지 않고 실제 front door와 production composition에서 Goal의
보안·freshness·budget·attach 계약을 증명한다.

## 현재 사실

- PTY file은 11 case이며 discovery/create/show/default-off/autonomous continuation/quiescence/restart/
  checkpoint를 다룬다.
- control/verify/budget/blocker/attach public matrix 일부가 없다.
- 일반 smoke runner는 plain `runAgent`만 조립하며 ObjectiveAuthority/verifier/wake가 없다.
- 따라서 기존 `tests/smoke/fixtures`에 goal prompt만 추가하면 Goal smoke가 아니라 vacuous agent smoke다.

## rail 배치

### PTY에 둘 것

- `check add → verify → source edit → stale`
- `pause → resume → edit`
- `--max-turns=2` 후 autonomous stop과 limiting source 표시
- attach thread B 후 A continuation body 0
- `/goal unblock` operator escape hatch

PTY는 raw-mode/real binary/command parser/session persistence를 증명하는 항목만 가진다.

### Integration에 둘 것

- no-progress exponential backoff
- blocker 2/3 → 3/3, progress reset
- strict sandbox unavailable/degraded spawn 0
- browser `goal.state` snapshot/reconnect/default-observability-off
- close-start/attach generation dequeue fences

fake clock/registry/failure injection이 필요한 항목은 PTY로 올리지 않는다.

### Dedicated Goal smoke

`tests/smoke/goal/`은 기존 generic fixture runner를 그대로 사용하지 않는다. production objective authority,
attempt slot, verifier, wake, replay LLM을 조립하는 dedicated host-level harness를 가진다.

최소 corpus:

1. default-ON active goal pursuit and settlement
2. checked verification under strict sandbox/posture
3. budget stop with no extra wake

각 scenario assertion은 final text가 아니라 ObjectiveDomainSnapshot, progress receipt, spawn/enqueue count를
검사한다.

## 실행 작업

1. 현재 PTY 전체 wall time을 3회 실측하고 median/max, per-case timeout을 기록한다.
2. 한 test에 여러 failure cause를 묶지 않고 위 matrix를 rail별로 추가한다.
3. dedicated smoke harness와 anti-vacuum assertion floor를 만든다.
4. source/installed binary parity를 동일 corpus로 검증한다.
5. 각 핵심 invariant에 revert/mutant 한 개 이상을 실행해 RED receipt를 남긴다.
6. feature catalog evidence/modes/monitoring을 실제 통과 rail까지만 갱신한다.

## RED rails

- verifier sandbox bypass, read reconcile 제거, blocker stable ID 제거, wake close fence 제거, web snapshot
  replay 제거가 각각 대응 test를 실패시킨다.
- Goal authority가 harness에서 빠지면 smoke anti-vacuum floor가 실패한다.
- skipped/missing trajectory는 green으로 계산하지 않는다.
- 한 test timeout이 suite success를 가리지 않는다.

## DoD

- focused PTY/integration/smoke가 모두 current HEAD에서 green.
- source CLI와 built CLI의 public behavior가 동일.
- full unit/integration/typecheck/lint/fc gate와 최종 clean state receipt가 있다.
- evidence가 없는 headless/batch mode를 catalog에 추가하지 않는다.

## 중단 조건

- generic smoke prompt만으로 Goal behavior를 증명했다고 주장하는 경우.
- production 안전 clamp를 test-only knob로 우회하는 경우.
- 전체 suite 없이 promotion 완료를 보고하는 경우.

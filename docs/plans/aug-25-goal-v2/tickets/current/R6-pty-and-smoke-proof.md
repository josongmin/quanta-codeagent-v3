# R6 — Public PTY, integration, and dedicated Goal smoke proof

**Status:** DONE · FINAL PROMOTION GREEN · **Priority:** P2 · **Owner:** Goal promotion evidence

## 목적

이미 있는 unit behavior를 중복 구현하지 않고 실제 front door와 production composition에서 Goal의
보안·freshness·budget·attach 계약을 증명한다.

## 구현 결과

- PTY file은 16 case다. 기존 11 case에 pause/resume/edit, check/verify/stale,
  user budget stop, attach cancellation, unblock public rail을 추가했다.
- `tests/smoke/goal/goal-pursuit-smoke.test.ts`가 production authority, attempt slot,
  strict verifier runner, wake controller, runtime host, replay LLM을 직접 조립한다.
- `bun run smoke:goal`은 default pursuit/settlement, strict checked verification,
  budget stop/no-extra-wake, component omission anti-vacuum을 4 case로 고정한다.
- 일반 smoke runner는 계속 generic agent fixture를 소유한다. Goal completion 증거로 사용하지 않는다.

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

## 최종 evidence — 2026-08-31

- focused integration + dedicated smoke: **71 pass, 0 fail, 8 files**.
- source PTY 16-case 전체 3회: **199.57s / 200.77s / 216.16s**;
  median **200.77s**, max **216.16s**, skipped 0.
- compiled `dist/agent` 동일 16-case: **16 pass, 0 fail, 186.07s**, skipped 0.
- production quiet-window minimum 15초를 우회하지 않았다. budget case timeout은 120초,
  attach/restart 계열 timeout은 최대 180초다.
- anti-vacuum/revert rails: dedicated harness component omission, lifecycle producer live-call
  injection ratchet, strict sandbox unavailable/degraded spawn 0, read-time source mutation,
  attach generation cancellation이 각 owner test에서 fail-closed를 고정한다.
- 전체 promotion command와 최종 clean-tree 증거는
  [`../../FINAL-RECEIPT-2026-08-31.md`](../../FINAL-RECEIPT-2026-08-31.md)에 있다.

## 중단 조건

- generic smoke prompt만으로 Goal behavior를 증명했다고 주장하는 경우.
- production 안전 clamp를 test-only knob로 우회하는 경우.
- 전체 suite 없이 promotion 완료를 보고하는 경우.

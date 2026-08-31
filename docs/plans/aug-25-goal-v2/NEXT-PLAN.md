# aug-25 /goal v2 — 현재 잔여 작업 계획

제품 소스 재대조 기준: `08fb52c175b0289cb26d794bbab9862851b9904d` (2026-08-31).
최종 audit checkout `32ea147dba3eb2daf429f762cce6e35a3d4c4933`까지 제품 경로 diff는 비어 있고,
그 사이 commit은 Goal 계획·catalog 정리다. SHA, focused 85/0 rail, 실행하지 않은 gate는
[`tickets/current/AUDIT-2026-08-31.md`](tickets/current/AUDIT-2026-08-31.md)에 동결했다.

이 문서는 현재 우선순위와 dependency order의 진실원이다. 패킷별 owner, write set, RED rail,
DoD는 [`tickets/current/`](tickets/current/README.md)가 소유한다. 과거 GOAL-01~10 티켓과 receipt는
historical evidence이며 현재 미구현 목록으로 사용하지 않는다.

## 현재 완료 경계

### 구현·집적 완료

- 브라우저 `/goal` 전체 control verb: show/create/work/pause/stop/resume/edit/clear/abandon,
  budget/unblock, criterion add+done, check add/verify.
- web mutation의 structured revision CAS, command receipt correlation, newer-revision readback.
- shared `ObjectiveVerificationPort`, verifier 진입점 expected-revision 재검사, before/after source digest.
- host-attributed attempt settlement, measured budget, approval 재귀속, manual attestation,
  abandon/unblock, bounded wake와 attach-generation fencing.
- CLI/web default-ON Goal preset과 explicit `QUANTA_GOAL=0` opt-out.

### 남은 구현

| 실행 순서 | 티켓 | 현재 gap | 확정 종료 형태 |
|---|---|---|---|
| 1 | [R1 verifier sandbox](tickets/current/R1-verifier-sandbox-posture.md) | **FOCUSED GREEN · main integration pending** | `workspace-write`, network deny, unavailable/degrade fail-closed, persistent versioned posture |
| 2 | [R2 read freshness](tickets/current/R2-read-time-source-freshness.md) | **FOCUSED GREEN · main integration pending** | CLI/web canonical reconcile, closed freshness payload, unresolved checked-completion masking, single wake rearm |
| 3 | [R3 blocker identity](tickets/current/R3-blocker-dependency-authority.md) | **FOCUSED GREEN · main integration pending** | host registry `dependencyId`, bounded occurrence pairs, dependency-based dedupe, typed unresolved |
| 4 | [R7 attach/close seam](tickets/current/R7-cli-attach-close-seam.md) | dead `attachingOrClosing` seam, close-start와 disposer 사이 teardown window | attach hook 단일 truth, dead field 삭제, interactive `finally` 첫 동작 synchronous stop |
| 5 | [R4 web always-on state](tickets/current/R4-web-always-on-goal-state.md) | structured payload에 freshness/wake/latest settlement가 없고 wake status가 버려짐 | existing `progressReceipts`를 포함한 canonical `goal.state` snapshot/delta와 absolute `wakeAt` |
| 6 | [R5 lifecycle telemetry](tickets/current/R5-objective-lifecycle-telemetry.md) | settlement decision counter 외 lifecycle producer가 없음 | bounded stage/outcome sink와 metrics adapter, identifier/text label 금지 |
| 7 | [R6 public proof battery](tickets/current/R6-pty-and-smoke-proof.md) | public control/verify/budget/attach rail과 Goal-aware smoke가 부족 | PTY/integration 분리, production authority를 조립한 dedicated Goal smoke, full gate receipt |

### 의도적 보류

[R8 headless/batch autonomous pursuit](tickets/current/R8-headless-batch-deliberate-hold.md)는 현재 완료
blocker가 아니다. batch는 corpus verdict와 per-instance termination의 별도 owner가 있고, headless는
one-shot/single-trajectory 계약이다. 제품이 persistent goal-runner semantics를 승인하기 전에는 wake
controller를 추가하지 않는다.

## dependency DAG

```text
R1 sandbox/posture ──> R2 read freshness ──┐
                                           ├─> R4 web state ──┐
R3 blocker identity ────────────────────────┘                  ├─> R5 telemetry ──> R6 proof
R7 attach/close seam ──────────────────────> R4 web state ────┘

R8 headless/batch: deliberate hold, DAG 밖
```

- R1이 verifier outcome/receipt contract를 고정한 뒤 R2가 그 receipt의 read-time freshness를 다룬다.
- R7이 wake lifecycle truth를 하나로 만든 뒤 R4가 그 상태를 browser projection에 노출한다.
- R5는 R1~R4의 확정된 producer outcome만 계수한다.
- R6은 앞선 계약을 실제 front door와 production composition에서 마지막으로 고정한다.

## 확정 설계 경계

- completion, budget, blocker threshold verdict owner는 `ObjectiveAuthority` 하나다.
- R1은 strict per-call sandbox를 사용하고 global CLI sandbox와 이중 wrap하지 않는다.
- R2는 `ObjectiveVerificationPort.reconcile`을 재사용한다. surface가 digest/completion을 재구현하지 않는다.
- R3은 host-known registry identity가 없는 external/network dependency를 정직하게 unresolved로 남긴다.
- R4는 새 settlement sink/store를 만들지 않고 objective domain `progressReceipts`를 투영한다.
- 실제 wake union은 `armed|pending|idle|stopped`이며, reconnect 가능한 absolute `wakeAt/retryAt`을 쓴다.
- R5 metric label은 closed enum만 허용하고 goal text나 각종 ID를 싣지 않는다.
- R6 generic smoke runner는 ObjectiveAuthority/verifier/wake가 없어 Goal proof로 사용하지 않는다.
- R7은 existing attach lifecycle hooks만 truth로 유지하고 dead boolean seam을 삭제한다.

## 공통 중단 조건

- browser-only completion store, verifier-only receipt store, second blocker store를 추가하려는 경우.
- rendered text 또는 normalized prose/hash를 identity, CAS, freshness, dependency key로 쓰려는 경우.
- sandbox unavailable/degrade를 일반 check failure나 runner unavailable로 축약하는 경우.
- default-OFF observability pane을 default-ON Goal의 유일한 visibility surface로 삼는 경우.
- import/comment/bare identifier만 검사해 live call 제거 후에도 green인 static guard를 추가하는 경우.
- source/HEAD가 verification rail 중간에 움직였는데 완료 receipt를 쓰려는 경우.

## 최종 종료 조건

각 티켓의 focused RED/GREEN과 persistence round-trip 후 R6에서 typecheck, test typecheck, lint,
lint-debt, architecture/god-code ratchet, full unit/integration, Goal PTY, dedicated Goal smoke,
feature-catalog validate/build/diff/evidence, `git diff --check`를 current HEAD에서 통과한다.

실행하지 않은 rail, skipped trajectory, stale SHA, product semantics 미결정을 완료로 보고하지 않는다.

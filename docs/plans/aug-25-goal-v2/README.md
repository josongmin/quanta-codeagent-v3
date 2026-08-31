# Goal v2 — 현재 상태와 문서 지도

이 폴더는 사용자 소유 장기 목표, host 비용 정산, 현재 소스 검증, 단일 완료 권한을 다룬다.
사용자는 `/goal`로 목표와 검증 가능한 종료조건을 만들고, 여러 turn에 걸쳐 작업을 계속하며,
신뢰된 증거가 충족될 때만 완료 상태를 얻는다.

## 현재 기준

- 현재 판정 기준은 R1~R7 구현과 이 문서를 함께 담은 final receipt-bearing tree다. 자기 SHA를
  문서에 다시 써서 생기는 순환 갱신은 하지 않으며 `git rev-parse HEAD`로 식별한다.
- `08fb52c17` 제품 소스와 `32ea147db` audit checkout은 최초 gap 재판정의 historical baseline이다.
- 최초 plan audit, R1~R8 재판정, 당시 focused 85/0 evidence는
  [`tickets/current/AUDIT-2026-08-31.md`](tickets/current/AUDIT-2026-08-31.md)에 기록했다.
- production 조립과 실제 consumer를 기준으로 대조했다. 과거 티켓의 예정 심볼명 존재 여부만으로
  완료나 미완료를 판정하지 않았다.
- 현재 우선순위와 dependency order의 진실원은 [`NEXT-PLAN.md`](NEXT-PLAN.md)다.
- 상세 owner/write set/RED/DoD의 진실원은 [`tickets/current/`](tickets/current/README.md)다.

## 현재 판정

| 영역 | 판정 | 현재 경계 |
|---|---|---|
| GOAL-01/02 domain·policy | **DONE** | objective authority, actor별 capability, derived completion이 live |
| GOAL-03 verifier | **DONE** | fail-closed sandbox posture, persistent posture receipt, canonical read-time freshness reconcile이 promotion green |
| GOAL-04 settlement | **DONE** | host-attributed attempt, measured usage, durable settlement ordering이 live |
| GOAL-05 CLI control | **DONE** | default-ON `/goal`, product ceiling, manual attestation, abandon/unblock, settlement checkpoint가 live |
| GOAL-06 wake | **DONE** | attach hooks와 close-start synchronous stop이 단일 lifecycle truth이며 public PTY/attach fence가 green |
| GOAL-07 attach/fork | **BEHAVIOR DONE / SPEC DIVERGED** | 실제 fence는 `attachGeneration`과 attach lifecycle cancellation. 과거 `sessionEpoch` 설계는 현행 계약이 아님 |
| GOAL-08 browser controls | **DONE** | work attribution, approval resume attribution, revision CAS, receipt correlation, 전체 browser `/goal` verb가 live |
| GOAL-09 blockers | **DONE** | host RunLedger/TaskRegistry dependency identity, opaque occurrence evidence, typed unresolved가 promotion green |
| GOAL-10 evidence | **DONE** | settlement decision counter, bounded lifecycle counter, 16-case PTY, dedicated Goal smoke, full gate receipt가 있음 |
| Browser always-on state | **DONE** | canonical `goal.state` push/reconnect replay, freshness/wake/latest settlement, observability-independent UI가 promotion green |

## 남은 작업

우선순위와 dependency order는 [`NEXT-PLAN.md`](NEXT-PLAN.md), 상세 실행 계약은
[`tickets/current/`](tickets/current/README.md)에 있다.

R1~R7의 구현·검증 작업은 완료됐다. 최종 증거는
[`FINAL-RECEIPT-2026-08-31.md`](FINAL-RECEIPT-2026-08-31.md)에 있다.

headless/batch autonomous pursuit만 남은 구현 티켓이 아닌 deliberate hold다. 제품이 persistent
goal-runner semantics를 승인할 때만 별도 promotion 작업으로 연다.

## 문서 역할

| 문서 | 역할 | 현재 상태 판단에 사용 |
|---|---|---|
| [`README.md`](README.md) | 현재 요약과 문서 지도 | 예 |
| [`NEXT-PLAN.md`](NEXT-PLAN.md) | 현재 우선순위와 dependency order | 예 |
| [`tickets/current/`](tickets/current/README.md) | R1~R8 상세 owner/write set/RED/DoD | 예 |
| [`HISTORY.md`](HISTORY.md) | 2026-08-25~30 계획·실행 변천 | 아니오 |
| [`tickets/GOAL-*.md`](tickets/) | 당시 의도와 RED/Proof rail | 아니오, historical input |
| [`receipts/`](receipts/) | 당시 SHA·실행 결과 기록 | 아니오, historical evidence |
| [`GOAL-10-RECEIPT.md`](GOAL-10-RECEIPT.md) | 2026-08-26 promotion receipt | 아니오, historical evidence |

티켓과 receipt 안의 숫자, SHA, 예정 타입명, 미구현 판정은 기록 시점의 사실이다. 최신 상태와
충돌할 때는 현재 소스, `NEXT-PLAN.md`, `tickets/current/`, 이 README 순으로 우선한다.

## 현재 evidence 위치

- verifier: `src/host/runtime/objective-verifier-wire.ts`,
  `tests/integration/objective-verifier-real-command-e2e.test.ts`
- settlement: `src/host/runtime/internal/context-binding/objective-settlement.ts`,
  `src/host/runtime/internal/context-binding/turn-runner.ts`
- wake: `src/objective/goal-wake-host.ts`, `src/objective/goal-wake-policy.ts`
- lifecycle telemetry: `src/objective/lifecycle-telemetry.ts`,
  `src/observability/metrics/objective-lifecycle.ts`
- browser controls: `apps/web-frontend/src/components/slash-goal.ts`,
  `tests/integration/goal-control-ws-daemon-e2e.test.ts`
- public CLI: `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts`
- dedicated Goal smoke: `tests/smoke/goal/goal-pursuit-smoke.test.ts`
- catalog truth source: `tools/feature-catalog/features/09-integration/objective-*.yaml`,
  `tools/feature-catalog/features/09-integration/web-goal-controls.yaml`

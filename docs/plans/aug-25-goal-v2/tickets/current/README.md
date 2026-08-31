# Goal v2 current execution tickets

기준 소스 감사일: 2026-08-31. 현재 기준은 R1~R7 구현과 final receipt를 함께 담은 tree이며
`git rev-parse HEAD`로 식별한다. `08fb52c17`/`32ea147db`는 최초 gap 재판정의 historical baseline이고,
당시 audit evidence는 [`AUDIT-2026-08-31.md`](AUDIT-2026-08-31.md)에 동결했다.

이 디렉터리는 완료된 작업과 deliberate hold의 상세 실행 계약이다. 상위
[`NEXT-PLAN.md`](../../NEXT-PLAN.md)는 dependency order를 소유하고, 이 티켓들은 각
패킷의 owner/write set/RED/DoD를 소유한다. `tickets/GOAL-01~10`은 historical input이며
현행 구현 명세가 아니다.

| 순서 | 티켓 | 판정 | 종료 형태 |
|---|---|---|---|
| 1 | [R1 verifier sandbox](R1-verifier-sandbox-posture.md) | DONE | fail-closed sandbox + persistent posture |
| 2 | [R2 read freshness](R2-read-time-source-freshness.md) | DONE | CLI/web read-time reconcile |
| 3 | [R3 blocker identity](R3-blocker-dependency-authority.md) | DONE | registry identity + occurrence evidence |
| 4 | [R7 attach/close seam](R7-cli-attach-close-seam.md) | DONE | one lifecycle truth + close-start stop |
| 5 | [R4 web always-on state](R4-web-always-on-goal-state.md) | DONE | default-ON typed snapshot/push |
| 6 | [R5 lifecycle telemetry](R5-objective-lifecycle-telemetry.md) | DONE | bounded stage/outcome counters |
| 7 | [R6 public proof battery](R6-pty-and-smoke-proof.md) | DONE | PTY/integration/dedicated Goal smoke |
| hold | [R8 headless/batch](R8-headless-batch-deliberate-hold.md) | product hold | explicit exclusion until semantics change |

동결 audit 당시 판정은 R1~R7 **OPEN**, R8 **DELIBERATE HOLD**였다. 후속 R1~R7 packet은 구현,
owner-local/integration, source+built PTY, dedicated smoke, 전체 promotion gate를 통과했다. 최종 receipt는
[`../../FINAL-RECEIPT-2026-08-31.md`](../../FINAL-RECEIPT-2026-08-31.md)다.

## 공통 불변식

- `ObjectiveAuthority` 외부에서 completion, budget, blocker threshold verdict를 직접 쓰지 않는다.
- browser-only store, verifier-only parallel receipt store, second blocker store를 만들지 않는다.
- rendered text를 identity/CAS/freshness 입력으로 파싱하지 않는다.
- 모델 문자열, goal text, thread/objective/attempt/check ID를 metric label로 쓰지 않는다.
- static guard는 live call/structure를 검사하고 anti-vacuum floor와 RED-on-injection을 가진다.
- 한 패킷 완료는 owner-local RED/GREEN, integration rail, persistence round-trip, 문서/catalog 정합을
  모두 요구한다.

## 통합 게이트

각 티켓의 focused gate 이후 마지막 R6에서 다음을 순차 실행한다.

```sh
bun run typecheck
bun run typecheck:tests
bun run lint
bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch
bun test tests/unit
bun test tests/integration
bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
bun fc validate
bun fc build
bun fc diff
bun fc check-evidence
git diff --check
```

전체 suite를 실행하지 않았거나 source/HEAD가 rail 중간에 움직이면 완료 receipt를 쓰지 않는다.

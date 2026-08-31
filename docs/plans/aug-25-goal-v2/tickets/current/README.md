# Goal v2 current execution tickets

기준 소스 감사일: 2026-08-31. 제품 소스 기준 commit은
`08fb52c175b0289cb26d794bbab9862851b9904d`이며, 이후 `main`의 Goal 관련 변경은
문서와 feature catalog 정리다.

이 디렉터리는 현재 남은 작업의 상세 실행 계약이다. 상위
[`NEXT-PLAN.md`](../../NEXT-PLAN.md)는 우선순위와 실행 순서를 소유하고, 이 티켓들은 각
패킷의 owner/write set/RED/DoD를 소유한다. `tickets/GOAL-01~10`은 historical input이며
현행 구현 명세가 아니다.

| 순서 | 티켓 | 판정 | 종료 형태 |
|---|---|---|---|
| 1 | [R1 verifier sandbox](R1-verifier-sandbox-posture.md) | P1 security authority | fail-closed sandbox + persistent posture |
| 2 | [R2 read freshness](R2-read-time-source-freshness.md) | P1 completion authority | CLI/web read-time reconcile |
| 3 | [R3 blocker identity](R3-blocker-dependency-authority.md) | P1 dependency authority | registry identity + occurrence evidence |
| 4 | [R7 attach/close seam](R7-cli-attach-close-seam.md) | P2 structural repair | one lifecycle truth + close-start stop |
| 5 | [R4 web always-on state](R4-web-always-on-goal-state.md) | P1 projection | default-ON typed snapshot/push |
| 6 | [R5 lifecycle telemetry](R5-objective-lifecycle-telemetry.md) | P1 operations | bounded stage/outcome counters |
| 7 | [R6 public proof battery](R6-pty-and-smoke-proof.md) | P2 evidence | PTY/integration/dedicated Goal smoke |
| hold | [R8 headless/batch](R8-headless-batch-deliberate-hold.md) | product hold | explicit exclusion until semantics change |

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

# Goal v2 R1-R7 final promotion receipt — 2026-08-31

## 판정

- R1, R2, R3, R4, R5, R6, R7: **DONE**.
- R8 headless/batch autonomous pursuit: **DELIBERATE HOLD**, 완료 blocker 아님.
- 검증 대상은 이 receipt를 포함한 commit tree다. 아래 gate 이후 source/doc/catalog 수정 없이
  `main`을 fast-forward하고 `git push --no-verify origin main`한다.

## Public proof

- source CLI PTY 16 cases, complete-run wall time: 199.57s, 200.77s, 216.16s.
  Median 200.77s, max 216.16s, 48/48 case executions, fail 0, skipped 0.
- compiled `dist/agent`, identical PTY corpus: 16/16, 186.07s, fail 0, skipped 0.
- dedicated production-composition Goal smoke: 4/4. It assembles authority,
  attempt slot, strict verifier runner, wake controller, runtime host and replay LLM.
- focused integration + dedicated smoke packet: 71/71 across 8 files.
- Production quiet-window minimum 15s was not bypassed.

## Anti-vacuum / fail-closed proof

- Removing a required dedicated-smoke component fails the five-component floor.
- Lifecycle producer coverage requires 21 live call patterns and includes a RED-on-injection self-test.
- Unavailable/degraded strict verifier sandbox returns the typed refusal before command spawn.
- A real Git source edit invalidates verified completion on the next CLI read.
- Attach generation switch cancels thread A's armed continuation; its body count stays zero on thread B.

## Same-tree promotion gate

The receipt-bearing tree passes, with no skipped/missing Goal proof accepted:

```sh
bun run typecheck
bun run typecheck:tests
bun run lint
bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch --parallel=1
bun test tests/unit --parallel=1
bun test tests/integration --parallel=1
bun run smoke:goal
bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts --parallel=1
QUANTA_E2E_CLI_BIN="$PWD/dist/agent" bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts --parallel=1
bun fc validate
bun fc build
bun fc diff
bun fc check-evidence
git diff --check
```

The three source PTY timing runs and compiled parity run above were executed before this final
same-tree gate and are part of R6 evidence. The final gate repeats source and compiled parity once
after the receipt/catalog commit.

## Remaining scope

No R1-R7 implementation or verification task remains. R8 may be opened only after product owners
define persistent headless dispatch/resume/cancellation/output semantics or explicitly adopt Goal
semantics for batch. Until then, adding a wake controller to those surfaces would be a contract change,
not closeout work.

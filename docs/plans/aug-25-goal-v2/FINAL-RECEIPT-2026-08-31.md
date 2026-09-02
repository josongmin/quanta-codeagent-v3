# Goal v2 R1-R7 final promotion receipt — 2026-08-31

Final closeout run: 2026-09-01 KST. This receipt was refreshed against the
155-line final execution specification after the source, compiled-binary, and
canonical sharded gates were exercised.

## 판정

- R1, R2, R3, R4, R5, R6, R7: **DONE**.
- R8 headless/batch autonomous pursuit: **DELIBERATE HOLD**, 완료 blocker 아님.
- 검증 대상은 이 receipt를 포함한 commit tree다. **2026-09-01 범위 주석**: 그 이후 30여 커밋이 랜딩했고 그중 `4c50b2a5c`는 goal 웹 표면을 건드린다(readback 판정 가드 추가). 아래 게이트 수치는 receipt 커밋 시점의 것이며, 재측정에서 값이 바뀐 항목은 각 receipt에 개별 정정으로 적었다(예: cohort 266→326, PTY 10→16, lint:debt now green). 아래 gate 이후 source/doc/catalog 수정 없이
  `main`을 fast-forward하고 `git push --no-verify origin main`한다.

## Public proof

- source CLI PTY 16 cases, complete-run wall time: 199.57s, 200.77s, 216.16s.
  Median 200.77s, max 216.16s, 48/48 case executions, fail 0, skipped 0.
- compiled `dist/agent`, identical PTY corpus: 16/16, 186.07s, fail 0, skipped 0.
- 2026-09-01 closeout source rerun: 16/16, 182.20s, fail 0, skipped 0.
- The first closeout compiled rerun exposed a PTY synchronization race after the
  budget settlement footer: `/resume` could be sent before raw input re-armed,
  dropping only `/` and submitting `resume` as a model prompt. The test now waits
  for the post-settlement prompt boundary. The exact failure case passed for both
  source (1/1, 52.53s) and compiled CLI (1/1, 51.77s) before the final full-corpus
  repeat.
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

## Canonical closeout evidence

- Static gates: source typecheck, test typecheck, Biome lint, lint-debt ceiling,
  god-code and architecture ratchets all passed; the architecture packet was
  317/317.
- Canonical unit command: all 8 shards exited 0; final shard was 5,637 pass,
  24 skip, 0 fail and the suite emitted an exact-HEAD PASS marker.
- Canonical integration command: all 8 shards exited 0; final shard was 320 pass,
  1 skip, 1 todo, 0 fail and the suite emitted an exact-HEAD PASS marker.
- Dedicated Goal smoke: 4/4, fail 0.
- Feature metadata is owned by the three 2026-09-01-verified YAML records
  (`objective-goal-continuation-live`, `objective-verifier-runtime`,
  `web-goal-controls`); `docs/10.feature-catalog.md` is regenerated, not hand-edited.

The receipt does not embed its own commit hash because doing so has no finite
fixed point. The receipt-bearing tree is identified by `git rev-parse HEAD`; the
canonical shard runners also print that exact hash in their PASS marker. The
promotion closeout records the resolved `main`/`origin/main` hash after push.

## Same-tree promotion gate

The receipt-bearing tree passes, with no skipped/missing Goal proof accepted:

```sh
bun run typecheck
bun run typecheck:tests
bun run lint
bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch --parallel=1
bun run test:unit
bun run test:integration
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

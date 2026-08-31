# GOAL-00R — Current-head baseline, owner freeze, and pre-existing PTY isolation

> **ARCHIVED TICKET** — 당시 실행 입력이다. 현재 상태/실행 순서는
> [`../README.md`](../README.md)와 [`../NEXT-PLAN.md`](../NEXT-PLAN.md)를 따른다.

> **구현 대조 (2026-08-30, 코드 확인)** — 절차 티켓이라 코드 대조 대상은 Entry snapshot뿐이다.
> 그 SHA들(`93d1e40ee`/`412269e76`/`b4f1b5286`)과 `PTY 9/9`는 착수 시점 값이다. 스냅샷으로만 읽을 것.

## Purpose

Create a reproducible execution baseline before changing Goal v2. The former staged-slice workflow is historical: commit `1624c7c` is not the current worktree and must not drive new edits or receipts.

## Entry snapshot

- Historical Goal baseline: `d06161c85`, `e510389aa`, `93d1e40ee`.
- At plan audit time: `HEAD=93d1e40ee031ee4a8659f93833b2de400a6055c9`, `origin/main=412269e76`; at execution start `HEAD=origin/main=b4f1b5286`, PTY 9/9 ×2. Re-freeze both immediately before implementation.
- Existing unrelated dirty files are user-owned. Do not stage, restore, reformat, or include them.
- The index must be empty before each Goal ticket starts. If it is not, stop and resolve ownership; never use `git restore --staged .`.

## Write set

- `docs/plans/aug-25-goal-v2/receipts/GOAL-00.yaml`
- A narrowly identified existing PTY cassette owner only if the baseline failure reproduces and its repair is required to make the baseline truthful.

No Goal feature implementation belongs in this ticket.

## Execution

1. Record full `HEAD`, `origin/main`, branch, porcelain-v2 status, staged diff, and the Goal baseline commits.
2. Inventory every dirty path and classify it as Goal-owned, unrelated user work, or generated output. Stop on ambiguous ownership.
3. Run the existing baseline rails at the frozen SHA without modifying the worktree.
4. If the PTY suite fails, reproduce the exact cassette/test in isolation and save the failing command, exit code, and bounded output digest.
5. Repair only the demonstrated cassette/normalizer owner. Do not absorb a pre-existing PTY failure into a Goal feature ticket.
6. Re-run the isolated RED rail, then the full PTY suite and baseline rails.
7. Write a repo-local receipt containing the frozen SHA, dirty-path allowlist, commands, exit codes, durations, and output digests.

## RED rail

- A receipt generated against a different `HEAD` or with an unlisted dirty path is rejected.
- A staged path outside the ticket write set is rejected.
- The isolated PTY regression must fail before its repair and pass after it; a non-reproducing failure is recorded as blocked, not silently waived.

## Verification

```bash
bun run typecheck
bun run lint
bun run lint:debt
bun test tests/unit tests/integration --parallel=1
bun run test:contract
bun test tests/meta
bun run e2e:pty
bun fc validate
bun fc diff
git diff --cached --check
```

## Stop conditions

- `HEAD`, index state, or dirty-path ownership changes during the run.
- A baseline repair requires a second authority owner or broad source edits.
- Any rail depends on deleting or overwriting unrelated work.
- The full PTY suite remains red after the isolated owner repair.

## Exit receipt

`GOAL-00.yaml` must prove the current execution SHA and baseline state. It is not a release receipt and this ticket does not push or install globally.

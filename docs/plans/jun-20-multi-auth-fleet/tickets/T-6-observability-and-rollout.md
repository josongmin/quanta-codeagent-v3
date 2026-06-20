# T-6: observability + rollout

**Priority:** P0 · **Size:** M · **Deps:** [T-3](T-3-pool-account-aware-scheduler.md), [T-4](T-4-microchunk-routing.md), [T-5](T-5-full-remote-auth-parity.md) · **Posture:** telemetry-first

## Deliverable

Expose enough operator truth to run multi-auth fleets without guessing.

Required surfaces:

- pool / full dry-run prints account labels and requested slot counts
- box status / box ls surfaces `accountLabel`
- report / sidecar metadata carries `accountLabel`
- operator can ask "which accounts are hot, cooling, idle, or disabled?"

This may land as a dedicated `quanta-bench auth status [--json]` surface, or as
an extension of existing status commands, but the account allocator state must
be observable.

## Touch files

- `src/apps/bench/cli.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- report / sidecar metadata owner under `src/runner/batch/eval/*`
- new `tests/integration/bench-auth-status-cli-e2e.test.ts`
- update `tests/integration/bench-box-ls-status.test.ts`

## Acceptance criteria

- [ ] operator can list accounts with `activeSlots`, `activeBoxes`, `cooldownUntil`
- [ ] box status shows which account label last owned the current chunk
- [ ] report metadata preserves account label for postmortem / leaderboard joins
- [ ] no token values appear in logs, status, report, or dry-run output
- [ ] single-auth mode still renders sane status (`single` / default account)

## Hellgates

- `bun test tests/integration/bench-auth-status-cli-e2e.test.ts`
- `bun test tests/integration/bench-box-ls-status.test.ts`

Red cases this ticket must pin:

- operator cannot tell which account is causing 429s
- account label is missing from report/status even though allocator used it
- observability leaks auth file paths or token material

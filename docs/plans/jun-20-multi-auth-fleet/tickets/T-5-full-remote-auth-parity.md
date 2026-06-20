# T-5: full-remote auth parity

**Priority:** P1 · **Size:** M · **Deps:** [T-1](T-1-auth-pool-manifest-and-resolver.md), [T-2](T-2-auth-lease-manager.md) · **Posture:** explicit label / auto-pick

## Deliverable

Unify `grade --mode full` with the same auth-source abstraction as `pool`.

Goals:

- single full-remote runs can still use a legacy `QUANTA_BENCH_AUTH_FILE`
- when an auth pool is configured, the operator can either:
  - let the resolver auto-pick an account, or
  - pin one explicitly via `--auth-label`

This avoids a dual-truth world where `pool` is multi-auth but `full-remote`
still secretly assumes one account file.

## Touch files

- `src/apps/bench/cli.ts`
- `src/apps/bench/remote/full.ts`
- new `tests/unit/bench-full-remote-auth-source-hellgate.test.ts`
- `tests/unit/bench-full-remote-hellgate.test.ts`
- `tests/integration/bench-cli-e2e.test.ts`

## Acceptance criteria

- [ ] `grade --mode full` resolves auth through the same source abstraction
- [ ] `--auth-label <label>` chooses that account or fails fast if missing
- [ ] dry-run prints the chosen account label
- [ ] legacy single-auth path stays byte-identical when no pool is configured
- [ ] `allow-extra-boxes` and auth selection do not race or contradict each other

## Hellgates

- `bun test tests/unit/bench-full-remote-auth-source-hellgate.test.ts`
- `bun test tests/unit/bench-full-remote-hellgate.test.ts`
- `bun test tests/integration/bench-cli-e2e.test.ts`

Red cases this ticket must pin:

- `pool` and `full-remote` diverge on auth resolution semantics
- explicit `--auth-label` is ignored
- dry-run hides which account would have been used

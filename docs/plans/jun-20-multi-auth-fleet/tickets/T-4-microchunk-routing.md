# T-4: microchunk routing

**Priority:** P1 · **Size:** M · **Deps:** [T-1](T-1-auth-pool-manifest-and-resolver.md), [T-2](T-2-auth-lease-manager.md) · **Posture:** opt-in

## Deliverable

Add an operator path to split a dataset into microchunks so chunk-level account
routing can approximate per-problem parallelism without invasive per-instance
auth mixing inside one `bench run`.

Examples:

- `chunkSize=1` -> one problem per chunk
- `chunkSize=6` -> one chunk roughly matches one account's safe loop budget

This can be a new helper command or a flag-driven pre-split path, but the output
must stay filesystem-stable and runId-safe.

## Touch files

- `src/apps/bench/cli.ts`
- new `src/apps/bench/slicing/microchunk.ts`
- new `tests/unit/bench-microchunk-hellgate.test.ts`
- new `tests/integration/bench-microchunk-cli-e2e.test.ts`

## Acceptance criteria

- [ ] operator can request `1 instance per chunk`
- [ ] chunk basenames remain unique / deterministic
- [ ] chunk order is stable
- [ ] pool accepts the produced microchunks unchanged
- [ ] dry-run prints the resulting chunk count and sample runIds
- [ ] no token material is copied into slice artifacts

## Hellgates

- `bun test tests/unit/bench-microchunk-hellgate.test.ts`
- `bun test tests/integration/bench-microchunk-cli-e2e.test.ts`

Red cases this ticket must pin:

- duplicate runId collision after micro-splitting
- chunk order nondeterminism between runs
- "problem-level parallelism" still requires manual JSONL surgery

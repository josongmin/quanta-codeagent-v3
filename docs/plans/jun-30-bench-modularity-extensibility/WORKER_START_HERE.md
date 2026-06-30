# Worker Start Here

## Mission

Make bench structurally maintainable without reducing current capability:

- no dual owner for the same runtime phase
- no env-mutation control channel between bench layers
- no new god-code allowlist entries
- no new source-string parity tests used as architecture glue

## What a worker should not spend time rediscovering

- `T1` is the real start. `T5` and `T6` look tempting but are downstream.
- the current worktree already has drift in acceptance/location-fanout/repair breadth files
- current red structural rails are mixed: some bench-owned, some unrelated
- remote `box-session` is not the worst modularization area; the core driver/surface path is

## Start order

Run tickets strictly in this order unless a ticket explicitly says it can parallelize:

1. `T1` single-owner runtime cutover
2. `T2` typed config SSOT
3. `T3` surface thinning
4. `T4` extension profiles + backend ports
5. `T5` selection/repair owner split
6. `T6` structural closeout

## Preflight

Run before touching code:

```sh
scripts/check-persona-target-policy.sh --expect-agent
git status --short
git diff --stat
```

Optional but recommended baseline capture for this packet:

```sh
rg -n "process\\.env" src/apps/bench src/runner/batch/eval | wc -l
bun test tests/unit/god-code-ratchet.test.ts tests/unit/src-no-sketchy-code.test.ts
```

## Current surrounding drift

The worktree is already dirty in these bench-adjacent files:

- `src/runner/batch/eval/acceptance-adapter.ts`
- `src/runner/batch/eval/acceptance-evidence.test.ts`
- `src/runner/batch/eval/acceptance-llm-rerank.ts`
- `src/runner/batch/eval/acceptance-select.ts`
- `src/runner/batch/eval/llm-candidate-select.ts`
- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/repair/candidate-ledger.ts`
- `src/runner/batch/eval/repair/candidate-ledger.test.ts`
- `src/runner/batch/eval/repair/types.ts`
- `tests/unit/location-set-fanout.test.ts`
- `tests/unit/repair-breadth-driver-fanout.test.ts`

Treat those as surrounding drift unless the active ticket explicitly owns them. Do not bury or overwrite them during broad refactors.

## First concrete move

Start with `T1`. Do not start in `T5` or `T6` first; both depend on runtime ownership being simplified first.

Exact first reads for `T1`:

```sh
sed -n '1,260p' src/apps/bench/eval/driver.ts
sed -n '1,260p' src/runner/batch/eval/driver.ts
sed -n '1,220p' tests/unit/runner/verify-select-driver-parity.test.ts
sed -n '1,120p' tests/unit/apps/bench/shared-verify-select-adapters.test.ts
```

## Stop rules

- If a ticket requires editing one of the already-dirty files above and the active change is not obviously compatible, stop and isolate the work or coordinate first.
- If a change only keeps two implementations in sync by adding more parity/string tests, back up and redesign the seam.
- If a change improves one surface by moving reusable semantics deeper into `src/apps/bench/**`, back up and move the logic below `src/apps/**`.

## Closeout artifact

For each completed ticket, add a short report under `reports/` following [reports/README.md](./reports/README.md).

Minimum closeout statement:

- what owner seam changed
- what proof rails passed
- what unrelated red remains
- what the next worker should pick up

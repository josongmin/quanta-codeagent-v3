# Source Truth Map

## Live bench entry surfaces

- `src/apps/bench/index.ts`
  - local run entry
  - dataset/custom-corpus mode selection
  - current env boot and observe/report wiring
- `src/apps/bench/cli.ts`
  - subcommand dispatch
  - remote grade/pool/box/auth/trace routing

## Reusable runtime owner candidates

- `src/apps/bench/eval/driver.ts`
  - current live app-side per-instance orchestrator
  - currently duplicates runtime phase ownership with the shared runner driver
- `src/runner/batch/eval/driver.ts`
  - shared helper library today
  - target owner for reusable per-instance runtime semantics

## Thin-surface contract

- `docs/ARCHITECTURE.md`
  - `src/apps/**` are composition/host surfaces
  - reusable batch/runtime semantics must live below `src/apps/**`

## Selection / repair cluster

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/selection-finalize.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/repair/index.ts`
- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair/candidate-ledger.ts`

These are the core files for `T5`. Current design includes an intentional reciprocal import between `selection-executor.ts` and `selection-finalize.ts`.

## Remote adapter cluster

- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- `src/apps/bench/remote/token-budget.ts`
- `src/apps/bench/remote/single-box-guard.ts`
- `src/apps/bench/remote/box-session/ec2-lifecycle.ts`

These are the main files for typed config plumbing and extension-port work.

## Structural rails

- `tests/unit/god-code-ratchet.test.ts`
- `tests/unit/src-no-sketchy-code.test.ts`
- `tests/unit/surface-coupling-ratchet.test.ts`
- `tests/unit/terminal-defaults-ratchet.test.ts`
- `tests/unit/runner/verify-select-driver-parity.test.ts`
- `tests/unit/apps/bench/shared-verify-select-adapters.test.ts`

## Non-authority surfaces

Useful for hints, not closure:

- comments claiming a module is already "thin"
- parity tests that only compare source text between two files
- older plan/RFC prose without current code confirmation
- stale line references in previous reports

## High-signal discovery commands

```sh
find src/apps/bench -maxdepth 2 -type f | sort
find src/runner/batch/eval -maxdepth 2 -type f | sort
rg -n "process\\.env" src/apps/bench src/runner/batch/eval
rg -n "const runRepairPhase = async|const runSelectionPhase = async|export const buildConfig =" src/apps/bench/eval/driver.ts src/runner/batch/eval/driver.ts
bun test tests/unit/god-code-ratchet.test.ts tests/unit/src-no-sketchy-code.test.ts
bun test tests/unit/surface-coupling-ratchet.test.ts tests/unit/terminal-defaults-ratchet.test.ts
```

## Ownership heuristics for this packet

- if the logic affects only terminal boot, CLI argument dispatch, or host I/O, it may stay in `src/apps/bench/**`
- if the logic can affect per-instance execution semantics across surfaces, it belongs below `src/apps/**`
- if a future dataset/backend/profile would need the logic too, it should not live only in one CLI subcommand body

# T1 — single-owner runtime cutover

**Priority:** P1  
**Depends on:** none  
**Parallelizable:** no

## Problem

Reusable per-instance runtime semantics are split between two owners:

- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/eval/driver.ts`

Both currently define phase orchestration such as `runRepairPhase` and `runSelectionPhase`. The repo preserves the split with parity/source-string tests instead of a single owner seam.

## Goal

Make `src/runner/batch/eval/**` the single owner of reusable per-instance bench runtime semantics, and reduce `src/apps/bench/eval/**` to a thin app adapter or shim.

## Scope

- `src/apps/bench/eval/driver.ts`
- `src/apps/bench/eval/index.ts`
- `src/runner/batch/eval/driver.ts`
- any new owner-local helper modules needed under `src/runner/batch/eval/**`
- tests currently pinning duplicate ownership

## Entry conditions

- do not start if you have not read both drivers and both parity tests
- do not widen into `selection`/`repair` decomposition except where duplicate runtime ownership forces it
- if current surrounding drift in `src/runner/batch/eval/**` conflicts with the cutover, isolate first

## Exact edit surfaces

Likely touched:

- app-only session/runtime host wiring in `src/apps/bench/eval/driver.ts`
- shared runtime phase orchestration in `src/runner/batch/eval/driver.ts`
- bench eval re-export surface in `src/apps/bench/eval/index.ts`
- tests that currently prove duplication instead of behavior

## Required changes

1. Identify the truly app-only concerns in `src/apps/bench/eval/driver.ts`.
   - examples: session host creation, capability manifest wiring, app-local runtime host construction
2. Invert or inject those app-only concerns into the shared runner driver as typed deps or ports.
3. Remove duplicated phase bodies from the app driver.
4. Keep a stable import surface for `src/apps/bench/eval/index.ts`, but make it a thin wrapper or re-export layer.
5. Replace source-string parity assertions with behavior/contract tests over the actual exported runtime.

## Suggested implementation order

1. list the app-only responsibilities that cannot move below `src/apps/**`
2. add typed deps/ports so the shared runner can accept those responsibilities without importing app code
3. move one phase owner at a time
4. collapse the app driver into a wrapper/shim
5. delete or replace duplication-preserving tests

## Explicit non-goals

- repo-wide cleanup outside bench runtime ownership
- eliminating every helper export from `src/runner/batch/eval/driver.ts` in this ticket
- deep selection/repair decomposition beyond what is required to delete duplicate runtime phase bodies

## Definition of done

- only one file tree owns reusable `runRepairPhase` / `runSelectionPhase` semantics
- app driver no longer mirrors shared runtime bodies
- architecture no longer depends on string parity tests to keep two implementations aligned
- existing app entrypoints still work through the new owner boundary

## Deliverables

- code cutover
- replacement behavior tests if parity tests are removed
- one report file under `reports/`

## Proof rails

```sh
bun run typecheck
bun test tests/unit/apps/bench/shared-verify-select-adapters.test.ts
bun test tests/unit/runner/verify-select-driver-parity.test.ts
bun test tests/unit/runner/no-patch-breaker-driver.test.ts tests/unit/selection-structural-repair-driver.test.ts
```

If parity tests are deleted or replaced, update the rail list accordingly and show the replacement contract tests.

## Stop rule

If this cutover only succeeds by keeping the same phase body in two files and adding more parity checks, stop. That is not closure.

## Blocked if

- app-only concerns cannot be isolated without first resolving unrelated surrounding drift
- proof requires a runtime entry path that no longer has a stable test seam

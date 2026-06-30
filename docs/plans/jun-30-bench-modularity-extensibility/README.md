# jun-30 bench modularity + extensibility packet

**Status:** ready for execution  
**Date:** 2026-06-30  
**Scope:** `src/apps/bench/**`, `src/runner/batch/eval/**`, bench-owned report/config/remote seams  
**Primary objective:** make bench execution semantics single-owner, typed-config-driven, and extension-friendly for future dataset/backend/profile growth.

## Why this packet exists

The live code already has real modularization work, but the core bench path is still structurally split across multiple owners:

- per-instance runtime semantics are duplicated between `src/apps/bench/eval/driver.ts` and `src/runner/batch/eval/driver.ts`
- bench surfaces (`index.ts`, `cli.ts`) still own too much runtime/config behavior
- bench control flow still depends heavily on `process.env` as a cross-layer control bus
- selection/repair internals have split-by-size modules and at least one intentional import cycle
- structural rails are not closed: bench-owned `god-code` and `src-no-sketchy-code` debt remains

This packet turns that into an ordered ticket queue with owner boundaries, proof rails, and stop rules.

## Low-context contract

This packet is written so a worker does **not** need prior chat context.

The worker must assume only this:

- live code beats comments, stale docs, and prior claims
- ticket order is authoritative unless a ticket explicitly says otherwise
- bench-owned closeout must stay separate from unrelated repo-global red
- a seam is not considered fixed if the old behavior survives through duplication plus parity tests

If a worker cannot prove a ticket's invariant from code + tests + the listed rails, the correct state is `partial` or `blocked`, not `done`.

## Target end state

1. `src/runner/batch/eval/**` is the single owner of reusable per-instance bench runtime semantics.
2. `src/apps/bench/**` is a thin host surface: argv/env parsing, boot wiring, subcommand dispatch, host-owned I/O.
3. dataset family, verifier choice, backend choice, and remote launch behavior flow through typed config/profile objects, not env mutation.
4. selection/repair helpers are cycle-free and decomposed by owner boundary, not only by file size.
5. bench-owned structural rails are green or explicitly separated from unrelated repo-global red.

## Execution order

1. [T1](./tickets/01-single-owner-runtime-cutover.md) — single-owner runtime cutover
2. [T2](./tickets/02-typed-bench-config-ssot.md) — typed config and argv/env SSOT
3. [T3](./tickets/03-surface-thinning-and-shared-boot.md) — thin `index.ts` / `cli.ts`
4. [T4](./tickets/04-extension-profiles-and-backend-ports.md) — extension-friendly dataset/backend/profile seams
5. [T5](./tickets/05-selection-repair-owner-split.md) — selection/repair decycle and owner-local split
6. [T6](./tickets/06-structural-closeout-and-ratchet-burndown.md) — structural closeout and ratchet burndown

## Packet map

- [WORKER_START_HERE.md](./WORKER_START_HERE.md)
- [00-index.md](./00-index.md)
- [EXECUTION_CHECKLIST.md](./EXECUTION_CHECKLIST.md)
- [NO_GO_RULES.md](./NO_GO_RULES.md)
- [SOURCE_TRUTH_MAP.md](./SOURCE_TRUTH_MAP.md)
- [tickets/README.md](./tickets/README.md)
- [reports/README.md](./reports/README.md)

## Required per-ticket artifact

Every completed ticket must leave:

1. code/test changes
2. one closeout note under `reports/`
3. explicit before/after proof for the ticket's own invariant

No ticket closes on prose alone.


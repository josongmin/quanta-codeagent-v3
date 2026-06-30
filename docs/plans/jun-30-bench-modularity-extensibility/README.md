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

1. The **app driver** (`src/apps/bench/eval/driver.ts`) stays the canonical per-instance orchestrator (it owns the SessionHost / RuntimeHost / capability-manifest wiring the live path needs); `src/runner/batch/eval/**` is the pure helper library it draws from. The runner driver's dead `runRepairPhase` / `runSelectionPhase` / `runInstance` twins are deleted, and shared *interiors* keep migrating down as exported pure helpers.
2. `src/apps/bench/**` surfaces (`index.ts`, `cli.ts`) are already thin host adapters (boot + dispatch); keep them that way.
3. dataset family, verifier choice, backend choice, and remote launch behavior flow through **one typed `DatasetFamilyProfile`** that owns the four scattered family layers (corpus-parse, grade-harness selection, remote env-profile, preflight) — not raw `process.env` string compares.
4. the in-process run path actually routes Pro/Live through the family seam (today it bypasses it and mis-parses/mis-grades Pro).
5. bench-owned structural rails stay green; the two driver-module god grandfathers are tracked as a separate decomposition campaign, not implied closed by this packet.

## Reality corrections (verified 2026-06-30 against HEAD `db63b8fd4`)

This packet was first drafted against a 2-commit-older tree. Live code overrode several premises:

- "make runner the single owner" is **inverted** — runner's phase twins are dead; the app driver is the live owner, and an arch guard forbids runner from importing the host stack it would need. (Precise: `runInstance`/`runInstanceOnce` already deleted in `ac3a266f8`; the remaining dead `runRepairPhase`/`runSelectionPhase` sit on an orphan chain AND are pinned by source-text parity tests that must be rewritten when they go.) See T1.
- T3 (thin `index.ts`/`cli.ts`) entry-split is done (131 / 204 lines, de-allowlisted) — but it **relocated** god-code debt into `run-main.ts` (910) and `commands/box.ts` (919), both just under the 1000 cap. Not "done" as a posture.
- T5's reciprocal cycle is a **real bidirectional value-cycle** relying on an unenforced "never call at module-init" rule; the project's TDZ-hang import-cycle guard covers `src/agent` only, leaving `runner/batch/eval` unprotected. Not optional — guard it and break it.
- The Pro family-bypass bug hits **remote runs too** — the full-remote box launches Pro via the same in-process entrypoint (`box-session.ts:380`), so every remote Pro run is currently vacuous-passing at the test-command level.
- The real maintainability lever is **T4** (single `DatasetFamilyProfile`) plus the **T2 family-bypass bug fix**, not the driver ownership shuffle.

## Execution order

0. **Commit-first gate** — land the in-flight acceptance-tier telemetry cluster (currently dirty, centered on `driver.ts`) and refresh the drift baseline before any ticket touches `driver.ts`.
1. [T2](./tickets/02-typed-bench-config-ssot.md) — typed dataset/config SSOT **+ fix the Pro family bypass** (highest value; affects local AND remote Pro)
2. [T4](./tickets/04-extension-profiles-and-backend-ports.md) — single `DatasetFamilyProfile` backend port (the headline "통합" ticket)
3. [T1](./tickets/01-single-owner-runtime-cutover.md) — driver dedup, **app driver as canonical owner**, delete the dead runner chain + its pinning tests as a unit
4. [T5](./tickets/05-selection-repair-owner-split.md) — extend the import-cycle guard to `runner/batch/eval` and break the selection value-cycle
5. [T6](./tickets/06-structural-closeout-and-ratchet-burndown.md) — retire the `runSelectionPhase` function grandfather; scope module grandfathers + `run-main.ts`/`box.ts` as separate decomposition work
6. [T3](./tickets/03-surface-thinning-and-shared-boot.md) — closeout note; flag `run-main.ts`/`box.ts` as near-cap follow-ups

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


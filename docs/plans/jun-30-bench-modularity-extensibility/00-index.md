# jun-30 bench modularity + extensibility — index / master status board

**Date:** 2026-06-30  
**Purpose:** worker-ready ticket packet for bench modularization and future extensibility.

## Live evidence snapshot

### Current green rails

- `tests/unit/surface-coupling-ratchet.test.ts`
- `tests/unit/terminal-defaults-ratchet.test.ts`
- `tests/unit/runner/verify-select-driver-parity.test.ts`
- `tests/unit/apps/bench/shared-verify-select-adapters.test.ts`
- `tests/unit/bench-detached-poll-box-death-hellgate.test.ts`
- `tests/unit/bench-sg-ingress-ssot-hellgate.test.ts`

### Structural ratchets: green-via-grandfather, not closed

As of HEAD both ratchets pass, so this is **not** a red→green packet:

- `tests/unit/god-code-ratchet.test.ts` — GREEN (recent convergence commits dropped `runRepairPhase`/`buildConfig` below the god-function threshold; they are no longer fresh failures)
- `tests/unit/src-no-sketchy-code.test.ts` — GREEN (bench composition-root env reads are allowlisted with explicit rationale; this is the legitimate boot/config boundary T2 protects)

The real bench-owned structural debt is the **grandfathered allowlist**, which the ratchet permits but No-Go rule #1 forbids growing. Verify against `tools/god-code/allowlist.json` before T6; at packet authoring time the bench grandfathers were:

- modules: `src/apps/bench/cli.ts`, `src/apps/bench/eval/driver.ts`, `src/apps/bench/index.ts`, `src/runner/batch/eval/driver.ts`
- function: `src/runner/batch/eval/driver.ts::runSelectionPhase`

T6 closes by **burning down those entries** as T1 (duplicate phase bodies) and T5 (`selection` decomposition) make the splits possible — not by chasing fresh red. Keep this separate from unrelated repo-global allowlist entries (`src/tool/**`, `src/host/**`, etc.), which are out of scope.

### Current large bench files

- `src/runner/batch/eval/driver.ts` — 6692 lines
- `src/apps/bench/cli.ts` — 2242 lines
- `src/apps/bench/eval/driver.ts` — 2162 lines
- `src/apps/bench/index.ts` — 1232 lines

### Current duplicated runtime seams

- `runRepairPhase` exists in both `src/apps/bench/eval/driver.ts` and `src/runner/batch/eval/driver.ts`
- `runSelectionPhase` exists in both `src/apps/bench/eval/driver.ts` and `src/runner/batch/eval/driver.ts`
- bench app tests currently preserve this split with source-string parity tests

### Current env-bus pressure

- `process.env` hits in `src/apps/bench/**`: 161
- `process.env` hits across `src/apps/bench/**` + `src/runner/batch/eval/**`: 204
- highest-density files: `src/apps/bench/index.ts`, `src/apps/bench/cli.ts`, `src/runner/batch/eval/driver.ts`, `src/apps/bench/eval/driver.ts`

## Ticket board

| ID | Ticket | Priority | Depends on | Parallel | Outcome |
|---|---|---|---|---|---|
| T1 | [single-owner runtime cutover](./tickets/01-single-owner-runtime-cutover.md) | P1 | none | no | one owner for reusable per-instance bench runtime |
| T2 | [typed bench config SSOT](./tickets/02-typed-bench-config-ssot.md) | P1 | T1 | partial | typed config replaces env-mutation control paths |
| T3 | [surface thinning + shared boot](./tickets/03-surface-thinning-and-shared-boot.md) | P2 | T1, T2 | partial | `index.ts` / `cli.ts` become host adapters |
| T4 | [extension profiles + backend ports](./tickets/04-extension-profiles-and-backend-ports.md) | P1 | T2, T3 | partial | dataset/backend/profile growth stops requiring deep surgery |
| T5 | [selection/repair owner split](./tickets/05-selection-repair-owner-split.md) | P1 | T1, T2 | no | cycle-free selection/repair seams |
| T6 | [structural closeout + ratchet burndown](./tickets/06-structural-closeout-and-ratchet-burndown.md) | P1 | T1-T5 | no | bench-owned rails closed and separated from unrelated repo red |

## Packet discipline

- Do not widen this packet into a repo-wide architecture cleanup.
- Do not claim repo-global green from a bench-only closeout.
- Do not preserve dual-owner runtime by adding more sync/parity tests.


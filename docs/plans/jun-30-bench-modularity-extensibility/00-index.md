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

### Current large bench files (HEAD `db63b8fd4`, re-measure before editing)

- `src/runner/batch/eval/driver.ts` — 6889 lines (god-module grandfather; will NOT drop under 1000 from this packet)
- `src/apps/bench/eval/driver.ts` — 2089 lines (god-module grandfather)
- `src/apps/bench/cli.ts` — **204 lines** (already split → `commands/*`, de-allowlisted)
- `src/apps/bench/index.ts` — **131 lines** (already split → `run-main`/`run-args`/`run-report`, de-allowlisted)

### Current duplicated runtime seams — note the live/dead asymmetry

- `runRepairPhase` / `runSelectionPhase` exist in both `src/apps/bench/eval/driver.ts` and `src/runner/batch/eval/driver.ts`
- BUT the runner copies are **un-exported and have zero production callers** — the live path is the app driver (`run-main.ts:46`, `apps/agent/mode-presets/batch.ts:56`). The runner driver only has a `runInstance` doc-comment admitting "no production caller" (`driver.ts:~3223`).
- the bodies are ~90% mirrored but genuinely diverge (runner-only `chaMultisiteSteer`, `acceptanceTier`, `regressionMaxTests`) — not byte-identical clones.
- consolidation direction: **delete the dead runner twins**, keep migrating shared interiors down as exported pure helpers (the e505cef9a `runRepairRoundsInSnapshot` shape). Do not promote the dead twin to "owner".

### Current env-bus pressure (re-measure)

- the real problem is scattered `process.env.QUANTA_SWEBENCH_DATASET_FAMILY` **reads** (~10 sites across `dataset-family.ts`, `remote/full.ts`, `remote/pool.ts`, `remote/box-session.ts`, `remote/box-session/ec2-lifecycle.ts`), NOT argv→env **writes** (there are zero env writes in `src/apps/bench/**`).
- family env vars are not declared in any knob schema — typed-config work must bring them into the SSOT.

## Ticket board

Execution order is revised (see README "Reality corrections"). Run T2 → T4 first; they carry the maintainability value.

| ID | Ticket | Priority | Depends on | Status | Outcome |
|---|---|---|---|---|---|
| T0 | commit-first gate | P0 | none | required | land dirty acceptance-tier cluster + refresh drift list before touching `driver.ts` |
| T2 | [typed dataset/config SSOT + Pro bypass fix](./tickets/02-typed-bench-config-ssot.md) | P1 | T0 | active | typed config replaces scattered env reads; **fixes Pro local mis-grade bug** |
| T4 | [single DatasetFamilyProfile backend port](./tickets/04-extension-profiles-and-backend-ports.md) | P1 | T2 | active | **headline:** adding a dataset family touches one owner, not four |
| T1 | [driver dedup — app driver as owner](./tickets/01-single-owner-runtime-cutover.md) | P2 | T0 | revised | delete dead runner chain (`_runV5AdaptiveAttempt`→`runMainPhase`→phases) + its pinning parity tests as a unit |
| T5 | [guard + break selection value-cycle](./tickets/05-selection-repair-owner-split.md) | P2 | T1 | revised | extend TDZ import-cycle guard to `runner/batch/eval`; break the executor/finalize value-cycle |
| T6 | [grandfather burndown (scoped)](./tickets/06-structural-closeout-and-ratchet-burndown.md) | P2 | T1 | scoped | retire `runSelectionPhase` fn entry; module grandfathers + `run-main.ts`/`box.ts` = separate campaign |
| T3 | [surface thinning](./tickets/03-surface-thinning-and-shared-boot.md) | P3 | — | entry done, debt relocated | `index.ts`/`cli.ts` thin (131/204); debt moved to `run-main.ts` (910) / `box.ts` (919) |

## Packet discipline

- Do not widen this packet into a repo-wide architecture cleanup.
- Do not claim repo-global green from a bench-only closeout.
- Do not preserve dual-owner runtime by adding more sync/parity tests — delete the dead twin instead.
- Do not make `runner/batch/eval/**` import `apps/**` or the host stack — the arch guard forbids it; the app driver stays the orchestrator.
- Re-measure every line count / env count against live HEAD before editing; this board drifts.


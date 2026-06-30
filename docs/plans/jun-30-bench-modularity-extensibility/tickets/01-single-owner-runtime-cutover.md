# T1 — driver dedup: app driver is the canonical owner

**Priority:** P2 (real cleanup, but T2/T4 carry the maintainability value)
**Depends on:** T0 (commit the dirty acceptance-tier cluster first — `driver.ts` is dirty)
**Parallelizable:** no

## Direction correction (read this first)

The original draft said "make `src/runner/batch/eval/**` the single owner, reduce the app driver to a shim." **That is backwards.** Audit against live code (HEAD `db63b8fd4`):

- the LIVE per-instance orchestrator is the **app driver** `src/apps/bench/eval/driver.ts` — its `runInstance`/`runInstanceOnce` are what `src/apps/bench/run-main.ts:46` and `src/apps/agent/mode-presets/batch.ts:56` actually call.
- the runner driver's `runRepairPhase` (`driver.ts:3859`) and `runSelectionPhase` (`driver.ts:4676`) are `const`, **un-exported, runtime-dead**: reachable only via the orphan chain `_runV5AdaptiveAttempt` (`:6700` — `_`-prefixed, zero callers) → `runMainPhase` (`:5720`) → both phases.
- the runner `runInstance`/`runInstanceOnce` are **already deleted** (commit `ac3a266f8`) — do NOT look for them to delete; only doc-comments remain (`:3223`, `:6661`).
- ⚠️ the dead runner phases are **pinned by source-text tests**: `tests/unit/runner/verify-select-driver-parity.test.ts:11` asserts `DRIVER_SRC.toContain("const runSelectionPhase = async")`, and `tests/unit/closure-repair-13212-probe.test.ts:198,215` is entangled with the repair-phase body. Deleting the phases flips these RED — they must be rewritten/removed in the SAME change (removing the parity test aligns with No-Go rule #2).
- the app driver needs a full host stack — `createSingleSessionRuntimeHost` (`@/host/runtime`), `SessionHost` (`@/kernel/session`), `capabilityManifestForConfig`, `createBenchSessionHost`, `runAgentViaSdk`. The runner driver calls bare `runAgent` (`@/agent`) and has none of this.
- `tests/unit/_arch/slice-boundary-configs.ts` makes `@/host` a Layer-2 seam that **must not be imported by `runner/**`**. Promoting the runner twin to owner would force runner→host→apps imports and break that guard.

So the correct end-state: **app driver stays the orchestrator; runner is the pure-helper library; the runner's dead phase twins get deleted; shared interiors keep migrating down as exported pure helpers** (the e505cef9a `runRepairRoundsInSnapshot` shape).

## Goal

Remove the duplicate phase bodies by deleting the dead runner copies and pushing any still-shared *interior* logic into exported runner helpers — without inverting the layer direction and without regressing the live app path.

## Scope

- `src/runner/batch/eval/driver.ts` — delete dead `runRepairPhase`/`runSelectionPhase`/`runInstance` twins; export any interior helper the app driver still needs
- `src/apps/bench/eval/driver.ts` — consume the extracted helpers; keep orchestration here
- `src/runner/batch/eval/driver.ts` exported helper surface

## Entry conditions

- T0 done: the acceptance-tier cluster (incl. dirty `driver.ts`) is committed and `git status` is clean
- you have read both drivers and confirmed which `runInstance` the production entry points resolve to
- you understand the real divergences before merging anything: runner-only `chaMultisiteSteer`, observe-only `acceptanceTier`, and `regressionMaxTests` (the app `runSelectionPhase` renames it `_regressionMaxTests` = unused). Do not graft these onto the live path or silently drop the app's `PreparedAttemptContext[...]` param projections.

## Required changes

1. Confirm (grep) the runner `runRepairPhase`/`runSelectionPhase` reach no live caller — trace the orphan chain `_runV5AdaptiveAttempt` → `runMainPhase` → phases and confirm `_runV5AdaptiveAttempt` has zero callers.
2. For any interior logic that genuinely belongs shared, extract it from the **app** body into an **exported pure runner helper** (closure-DI for the divergent bits, like `runAgentOnFork`) BEFORE deleting anything.
3. Delete the dead runner chain **as a unit**: `runRepairPhase`, `runSelectionPhase`, `runMainPhase`, `_runV5AdaptiveAttempt`. In the same change, rewrite or delete the source-text tests pinning them (`verify-select-driver-parity.test.ts:11`, `closure-repair-13212-probe.test.ts:198,215`) — replace with a behavior test over the live app runtime, not a `toContain` source match.
4. Keep the app driver as the orchestrator; it should read as: prepare context → call shared interiors → host/SDK wiring stays app-side. Do NOT touch the app driver's identically-named live functions.
5. Do not introduce any new source-string parity test (No-Go rule #2).

## Explicit non-goals

- making runner the single owner (forbidden by the arch guard)
- getting `src/runner/batch/eval/driver.ts` (6889 lines) or `src/apps/bench/eval/driver.ts` (2089 lines) under the god-module threshold — that is a separate decomposition campaign (see T6 note)
- deep selection/repair decomposition (that is T5, and it is optional)

## Definition of done

- the runner driver no longer contains dead `runRepairPhase`/`runSelectionPhase`/`runInstance` twins
- shared interior logic lives in exported runner helpers, consumed by the app driver
- no `runner/**` → `apps/**` or `runner/**` → `@/host` import was introduced (run the arch guard)
- the live app entry path still works through the app driver
- no new source-string parity test props up a duplicate

## Proof rails

```sh
bun run typecheck
bun test tests/unit/_arch/slice-boundary-configs.test.ts   # MUST stay green — proves no inversion
bun test tests/unit/apps/bench/shared-verify-select-adapters.test.ts
bun test tests/unit/closure-repair-13212-probe.test.ts   # must be updated to behavior, not source-match
bun test tests/unit/runner/no-patch-breaker-driver.test.ts tests/unit/selection-structural-repair-driver.test.ts
rg -n "const runRepairPhase = async|const runSelectionPhase = async|const runMainPhase|_runV5AdaptiveAttempt" src/runner/batch/eval/driver.ts  # expect empty after delete
# verify-select-driver-parity.test.ts is REMOVED/REWRITTEN by this ticket — confirm no source-text toContain remains
```

## Stop rule

If you find yourself making runner import the host stack, or keeping both phase bodies and adding a parity test, stop — you are re-inverting the layer. Delete the dead twin instead.

## Blocked if

- the runner twins turn out to have a live caller after all (re-verify; the audit found none)
- the in-flight `driver.ts` acceptance-tier work is not yet committed (do T0 first)

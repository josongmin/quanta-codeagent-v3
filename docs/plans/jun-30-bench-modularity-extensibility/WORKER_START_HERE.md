# Worker Start Here

## Mission

Make bench structurally maintainable without reducing current capability:

- no dual owner for the same runtime phase
- no env-mutation control channel between bench layers
- no new god-code allowlist entries
- no new source-string parity tests used as architecture glue

## What a worker should not spend time rediscovering

- This packet's first draft was overtaken by live commits. Trust live code, re-measure everything. See README "Reality corrections".
- **T2 + T4 are the real start**, not T1. They carry the maintainability value (typed family config + the single `DatasetFamilyProfile`).
- **T1's direction is inverted from the original draft.** The runner driver's `runRepairPhase`/`runSelectionPhase` are DEAD (un-exported, reachable only via orphan `_runV5AdaptiveAttempt`→`runMainPhase`). The live owner is the **app driver**. `runInstance`/`runInstanceOnce` were already deleted (`ac3a266f8`). Delete the dead phases **plus** `runMainPhase`/`_runV5AdaptiveAttempt` as a unit, AND rewrite the source-text parity tests that pin them (`verify-select-driver-parity.test.ts:11`, `closure-repair-13212-probe.test.ts`). An arch guard (`tests/unit/_arch/slice-boundary-configs.ts`) forbids runner from importing the host stack the app driver needs.
- **T3 entry-split is done but relocated debt** — `index.ts` 131 / `cli.ts` 204 (de-allowlisted), but `run-main.ts` is 910 and `commands/box.ts` is 919, both just under the 1000 cap. Closeout + flag as follow-ups; don't re-thin the entry files.
- **T5 is NOT optional** (adversarial audit reversed this). The `selection-executor ↔ selection-finalize` cycle is a real bidirectional value-cycle on an unenforced "no module-init call" rule; the TDZ import-cycle guard covers `src/agent` only, not `runner/batch/eval`. Extend the guard there and break the cycle.
- The highest-value single fix: the in-process run path (`run-main.ts:362,699`) bypasses the dataset-family seam, so **Pro runs (local AND remote — the box delegates to the same entrypoint, `box-session.ts:380`) silently mis-parse and vacuous-pass**. Fix in T2.

## Start order (revised — final)

0. `T0` commit the in-flight acceptance-tier telemetry cluster, refresh the drift list
1. `T2` typed dataset/config SSOT + Pro family-bypass fix (affects local + remote)
2. `T4` single `DatasetFamilyProfile` backend port (headline)
3. `T1` driver dedup, app driver as owner; delete the dead runner chain + its pinning tests as a unit
4. `T5` extend the import-cycle guard to `runner/batch/eval`; break the selection value-cycle
5. `T6` retire the `runSelectionPhase` function grandfather; defer module grandfathers + `run-main.ts`/`box.ts`
6. `T3` closeout note + near-cap follow-up flags

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

## Current surrounding drift (re-run `git status` — this drifts every commit)

The earlier drift list (acceptance-evidence.test / acceptance-llm-rerank / llm-candidate-select / location-fanout / repair-breadth / candidate-ledger / repair-types) is **STALE** — that work is now committed and clean.

The **actual current dirty set** is the jun-30 acceptance-tier telemetry cluster (observe-only, default-OFF):

- `src/runner/batch/eval/acceptance-adapter.ts`, `acceptance-select.ts`, `acceptance-selector.ts`, `acceptance-wire.ts`
- `src/runner/batch/eval/closure-diagnostics.ts`, `closure-diagnostics-io.ts`
- **`src/runner/batch/eval/driver.ts`** ← load-bearing collision: dirty AND the primary surface of T1/T2
- `src/runner/batch/types.ts`, `src/runner/batch/report.ts`
- `tests/unit/acceptance-adapter.test.ts`

This is RFC-declared (`docs/plans/jun-30-python-pro-synthesis-measure-first-rfc.md`) as the only net-new wiring for the Pro measurement. **Commit it first (T0), then start** — otherwise T1/T2 clobber uncommitted `driver.ts` work and the packet's own stop-rule won't fire (it checks the stale list).

## First concrete move

Run `T0`: commit the cluster above, confirm `git status` is clean, then start `T2`.

Exact first reads for `T2` (the real start):

```sh
rg -n "QUANTA_SWEBENCH_DATASET_FAMILY|resolveDatasetFamily|normalizeProRow|gradeEvaluatorForFamily|parseTasksForFamily" src/apps/bench src/runner/batch
sed -n '1,120p' src/apps/bench/dataset-family.ts
sed -n '340,420p' src/apps/bench/run-main.ts   # the in-process path that bypasses the family seam
sed -n '1,120p' src/apps/bench/remote/box-session/ec2-lifecycle.ts  # raw string-compare family logic
```

Exact first reads when you reach `T1` (driver dedup):

```sh
sed -n '1,260p' src/apps/bench/eval/driver.ts        # the LIVE orchestrator
rg -n "no production caller|runInstance|runRepairPhase|runSelectionPhase" src/runner/batch/eval/driver.ts
sed -n '1,120p' tests/unit/_arch/slice-boundary-configs.ts   # the guard forbidding runner->apps import
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

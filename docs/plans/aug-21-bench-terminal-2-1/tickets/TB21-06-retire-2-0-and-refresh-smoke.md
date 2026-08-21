# TB21-06 — retire Terminal-Bench 2.0 and refresh smoke

**Priority:** P1
**Size:** M
**Depends on:** BFND-01..03, TB21-00A, TB21-03, TB21-05
**Parallelizable:** no
**Live benchmark cost:** reuse the 2.1 canary

## Goal

Remove TB2.0 from every active source, script, report root, document authority,
and dashboard input after the TB2.1 canary/report/dashboard path is real.

## Required source retirement

Delete or replace:

- `tools/tb-smoke/**`;
- `tools/leaderboard-dashboard/rawdata/tb-pertask.md`;
- the old `tb-pertask.ts` parser if TB21-05 no longer needs it;
- the old `tb-report-emit.ts` after TB21-04 has proven canonical report writing;
- all active `terminal-bench/terminal-bench-2` and unversioned dataset commands;
- Harbor 0.16.1-specific invocation prose that is not true for the pinned version;
- TB2.0 any-pass/projection terminology and UI code;
- every active `datasetFamily: "terminal-bench"` field and raw dashboard family branch;
- terminal-only runtime-dead best-of-N source/tests/report fields;
- `QUANTA_TB_BEST_OF_N` knob inventory entry and generated knob-catalog output;
- tracked `__pycache__`, `.pyc`, and `.egg-info` artifacts under the adapter.

Do not remove the generic `src/apps/bench` Best-of-N sampler; it is a different
SWE-bench feature.

Do not remove the existing unified bench CLI, canonical report mirror, SWE
`DatasetFamily`, or knob registry. This ticket deletes obsolete Terminal owners,
not shared framework owners.

Do not remove shared BFND tests or ProMax's `swe-bench` family projection while
deleting legacy Terminal dashboard branches.

## Documentation retirement

Transfer any still-live 2.1 contract, then remove or supersede as active authority:

- `docs/rfc/jun-29-rfc-terminal-bench-integration.md`;
- `docs/plans/jul-2-terminal-bench-levers/**`;
- old TB2.0 evidence/prompts that would be mistaken for current proof;
- source comments and tests linking to the removed documents.

Git history is the archive. Do not leave stale docs in-tree merely to explain old
results while the product surface claims one active version.

## New smoke authority

Replace the handwritten TB2.0 target list with the revision-bound canary manifest
from TB21-03.

After the first 89-task `k=1` run, a separate measured smoke set may be generated
from 2.1 receipts using explicit classes:

- stable guard tasks;
- product regression witnesses;
- actionable misses solved by official competitors;
- infra-sensitive tasks.

The generator records the source run IDs, dataset ref, selection rule, and update
date. No task is called a guard or winnable based on TB2.0 results.

## Local artifact retirement

Known old active artifacts include:

- `~/.quanta/bench/results/report-terminal-bench-baseline.report.json`;
- `~/.quanta/bench/results/report-terminal-bench-levers.report.json`;
- `~/.quanta/bench/tb-raw/**`;
- `~/tb-results/full89/**` and related brain logs.

After a green 2.1 canary:

1. resolve each exact target path read-only;
2. move old reports/raw trees out of dashboard roots into one timestamped archive;
3. verify the dashboard no longer discovers them;
4. report the archive location and recoverability;
5. do not recursively delete a broad home/workspace path.

The new report parser independently rejects them; archival is not the only fence.

## RED rails

- A versionless TB2.0 report fixture must be rejected.
- `rg` must find no old dataset command in active source/docs.
- No terminal source imports the deleted terminal-only best-of-N modules.
- Knob completeness tests must pass after removing the dead knob entry.
- Tracked Python build artifacts must be absent.
- Dashboard with only archived/legacy reports must not show a current TB2.1 score.

## Proof rails

```sh
rg -n \
  'terminal-bench-2([^0-9-]|$)|Terminal-Bench 2\.0|TB2\.0|QUANTA_TB_BEST_OF_N|datasetFamily.{0,20}terminal-bench' \
  adapters src tools docs package.json
# expect no active authority matches; review any deliberate historical citation

git ls-files | rg '(__pycache__/|\.egg-info/|\.pyc$)'
# expect empty

python3 -m pytest -q adapters/terminal-bench/tests
bun test src/apps/terminal/*.test.ts
bun test src/apps/bench/benchmark-suite.test.ts src/apps/bench/commands/terminal.test.ts
bun test tools/leaderboard-dashboard/server.test.ts
bun test tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts
bun fc validate
bun fc build
bun fc diff
git diff --check
```

Only run feature-catalog build steps if a catalog YAML changed; commit the YAML and
generated `docs/10.feature-catalog.md` together.

## Definition of done

- There is no active TB2.0 runtime, command, report, matrix, or documentation owner.
- No `tools/terminal-bench` execution framework or Terminal-as-dataset-family
  compatibility path remains.
- Old local artifacts are outside active report roots and recoverable.
- TB2.1 canary remains green after cleanup.
- No dead terminal-local sampling surface or knob remains.
- Generated artifacts are no longer tracked under the Python adapter.

## Stop rule

If an old file still owns a live lever contract, migrate that contract and prove
its new consumer before deletion. Do not keep a dead compatibility file or delete
the only live contract blindly.

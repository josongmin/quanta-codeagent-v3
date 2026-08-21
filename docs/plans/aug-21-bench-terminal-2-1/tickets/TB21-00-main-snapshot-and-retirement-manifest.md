# TB21-00 — main snapshot and retirement manifest

**Priority:** P0
**Size:** S
**Depends on:** none
**Parallelizable:** no
**Live benchmark cost:** none

## Goal

Freeze the actual `main` state and enumerate every active TB2.0 authority before
editing. This ticket prevents direct-main work from overwriting user changes or
leaving a hidden 2.0 input in the dashboard.

## Entry facts

At original plan creation, `main` carried user-owned modifications in:

- `package.json` — version bump;
- `src/llm/adapters/chatgpt-oauth.ts` — client version change;
- `src/llm/factory.ts` — default model change.

These changes are not part of this campaign and must be preserved.
The tree may contain additional user/agent changes by execution time. The fresh
snapshot, not this historical list, defines the preservation boundary.

## Deliverables

1. An execution-time snapshot containing:
   - full and short SHA;
   - branch/upstream and ahead/behind state;
   - dirty file list and targeted diffs;
   - installed Bun/Python/uv/Harbor/Docker versions;
   - Docker daemon status;
   - active TB report roots and filenames.
2. A checked retirement manifest divided into:
   - source/runtime;
   - adapter/package;
   - scripts;
   - dashboard/report schema;
   - competitor rawdata;
   - docs/RFC/evidence;
   - local external run artifacts.
3. A framework-reuse manifest divided into:
   - shared BFND-01 suite/config and `src/apps/bench/cli.ts` unified CLI;
   - SWE-only `DatasetFamily` and future `DatasetFamilyProfile` internals;
   - existing knob inventory/runtime resolution;
   - shared BFND-02 report envelope, writer, and canonical mirror;
   - shared BFND-03 dashboard shell and suite-projector registry;
   - generic `src/apps/bench` Best-of-N sampler, which is not Terminal sampling.
4. A destination policy for old local artifacts:
   - remove from active report roots after the 2.1 canary is green;
   - move to a timestamped recoverable archive first;
   - delete permanently only with explicit target validation.

## Required inventory

At minimum, classify these known surfaces:

- `adapters/terminal-bench/{README.md,pyproject.toml,Dockerfile,quanta_agent.py}`;
- `tools/tb-smoke/**`;
- `tools/leaderboard-dashboard/{tb-report-emit.ts,tb-pertask.ts,server.ts}`;
- `tools/leaderboard-dashboard/rawdata/tb-pertask.md`;
- `src/apps/bench/{cli.ts,dataset-family.ts,preset.ts,report.ts}` and
  `src/runner/batch/report.ts`, classified as `reuse/extend`, not replacement;
- raw `datasetFamily === "terminal-bench"` branches in the dashboard, classified
  as replacement by the suite projector;
- terminal-only best-of-N source, tests, report fields, and knob inventory;
- `docs/rfc/jun-29-rfc-terminal-bench-integration.md`;
- `docs/plans/jul-2-terminal-bench-levers/**`;
- source comments linking to the retired docs;
- versionless reports under `~/.quanta/bench/results/`;
- raw TB2.0 jobs under `~/.quanta/bench/tb-raw/` and `~/tb-results/`.

Historical files are not retained merely because they are old. Transfer any live
contract still needed by 2.1, then delete the retired authority; Git is the history.

## Baseline proof

```sh
git rev-parse HEAD
git status --short --branch
git diff -- package.json src/llm/adapters/chatgpt-oauth.ts src/llm/factory.ts

rg -n \
  'terminal-bench-2([^0-9-]|$)|Terminal-Bench 2\.0|TB2\.0|--agent-import-path|QUANTA_TB_BEST_OF_N' \
  adapters src tools docs package.json

find "$HOME/.quanta/bench" -maxdepth 4 \
  \( -iname '*terminal-bench*' -o -iname '*tb*' \) -print
find "$HOME/tb-results" -maxdepth 3 -print
```

Record output paths and counts; do not paste secrets or full environment dumps.

## RED rails

- A snapshot that omits any execution-time dirty path is incomplete.
- A known TB2.0 surface without `replace`, `delete`, or
  `archive-after-canary` disposition fails the manifest.
- An existing shared bench owner without `reuse`, `extend`, or `out-of-scope`
  disposition fails the framework-reuse manifest.
- A dashboard/runtime consumer discovered after inventory but absent from the
  manifest stops implementation until classified.
- Any delete/archive command before exact read-only target resolution and a green
  2.1 canary is forbidden.

## Definition of done

- No edit started before the snapshot was recorded.
- Every active 2.0 input has an explicit `replace`, `delete`, or `archive-after-canary`
  disposition.
- Every existing bench owner has an explicit `reuse`, `extend`, or `out-of-scope`
  disposition; no second framework is planned implicitly.
- The snapshot records the exact BFND/T2 foundation state rather than assuming
  another product packet has landed it.
- Pre-existing user diffs remain byte-identical.
- No destructive local-artifact command has run.
- TB21-01 has an exact list of package/runtime owners to change.

## Stop rule

If a TB2.0 report or data source is consumed by a surface not listed in the
retirement manifest, stop and add that consumer before editing. Do not rely on a
post-hoc grep after deletion.

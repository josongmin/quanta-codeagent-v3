# Terminal-Bench 2.1 cutover — ticket backlog (SSOT)

Status: **PLANNED**
Execution branch: **`main` directly**
Compatibility policy: **Terminal-Bench 2.0 is retired, not supported in parallel**

This directory is the execution SSOT for replacing the current Terminal-Bench 2.0
adapter, reports, smoke campaign, and dashboard projections with one pinned
Terminal-Bench 2.1 rail.

Shared CLI/config/report/dashboard framework ownership lives in the
[benchmark foundation packet](../../aug-21-bench-foundation/tickets/README.md).
This packet registers and implements only the Terminal-Bench branch.

## Outcome

The cutover is complete only when one current-SHA Quanta configuration can:

1. enter through the existing `quanta-bench` CLI as a registered benchmark suite;
2. load as a versioned Harbor custom agent;
3. run the canonical `terminal-bench/terminal-bench-2-1` dataset;
4. emit auditable ATIF trajectories and lossless per-trial receipts through the
   existing canonical report sink;
5. calculate the same accuracy / standard error / pass@k semantics as the pinned
   upstream leaderboard implementation;
6. render those receipts through a suite-specific dashboard projector without any TB2.0
   data or any-pass projection contamination; and
7. close a full 89-task `k=1` measurement before spending on the official-shaped
   89-task `k=5` (445-trial) run.

Dataset-path replacement by itself is not completion.

## Planning snapshot

At plan creation (`2026-08-21`):

- repo HEAD was `11a54656bfc8` on `main...origin/main`;
- user-owned modifications already existed in `package.json`,
  `src/llm/adapters/chatgpt-oauth.ts`, and `src/llm/factory.ts`;
- Docker daemon was not ready and `harbor` was not installed on `PATH`;
- adapter tests were `29 passed`;
- selected Terminal/Pro TypeScript tests were `116 passed`;
- active docs and scripts still referenced `terminal-bench/terminal-bench-2` or the
  old `terminal-bench` shorthand;
- the dashboard consumed two TB2.0 reports from
  `~/.quanta/bench/results/report-terminal-bench-{baseline,levers}.report.json`;
- old raw runs existed under `~/.quanta/bench/tb-raw/` and `~/tb-results/full89/`.
- the upstream leaderboard `main` then declared dataset ref
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`,
  `EXPECTED_TASK_COUNT = 89`, and `MIN_TRIALS_PER_TASK = 5`.
- upstream stated that community submissions were closed; upload/public/submission
  therefore remains a separately authorized release action, not part of setup.

Re-freeze the live SHA, diff, Docker, Harbor, and report-root state at execution
time. The dirty tree has changed since the original snapshot; TB21-00 must preserve
every execution-time pre-existing diff, not only the three files listed above.
The values above are context, not reusable acceptance evidence.

## Non-negotiable decisions

### Benchmark suite is not dataset family

- The shared BFND-01 contract owns
  `BenchmarkSuite = swe-bench | terminal-bench` and imports the canonical SWE
  `DatasetFamily` instead of repeating its members.
- `DatasetFamily` remains internal to `swe-bench` and may independently gain
  `promax`; that does not change Terminal identity.
- Add this required versioned identity to every new Terminal-Bench manifest and report:

```json
{
  "schemaVersion": "terminal-bench-report/v2",
  "benchmarkSuite": "terminal-bench",
  "benchmarkVersion": "2.1",
  "dataset": "terminal-bench/terminal-bench-2-1",
  "datasetRef": "<canonical pinned ref>"
}
```

- `datasetFamily: "terminal-bench"` is invalid. Do not widen SWE parsing/grading
  branches to accommodate Terminal-Bench.
- A TB report missing that identity is legacy and must not enter the active 2.1
  score or matrix.
- Do not create a compatibility parser that guesses legacy reports are 2.1.

### Existing framework ownership

| Concern | Canonical owner | Terminal-Bench extension |
|---|---|---|
| CLI/composition | [BFND-01](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md) and `src/apps/bench/cli.ts` | `commands/terminal.ts` registration |
| suite config | BFND-01 `BenchRunConfig` union | Terminal config branch under `src/apps/bench/terminal/*` |
| run manifest | Terminal packet | `src/apps/bench/terminal/manifest.ts` |
| Harbor agent adapter | external adapter package | `adapters/terminal-bench/*` |
| terminal agent/brain | terminal app | `src/apps/terminal/*` |
| report serialization/mirror | [BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md) | typed Terminal branch passed to the canonical writer |
| dashboard | [BFND-03](../../aug-21-bench-foundation/tickets/BFND-03-dashboard-projectors.md) | Terminal projector registration and rendering |

- Do not create a `tools/terminal-bench` execution framework.
- Package scripts may only be thin aliases to `quanta-bench terminal ...`.
- Dashboard code may import/parse/project canonical reports but may not launch
  Harbor, resolve runtime knobs, emit reports, or own scoring formulas.
- The existing knob inventory/runtime resolver remains the value authority. A
  Terminal profile selects and records resolved values; it does not add a second
  ambient-env parser.

### Official scoring semantics

- Preserve every trial. Do not reduce trials to one any-pass boolean per task.
- For the leaderboard-shaped metric, errored trials carry reward `0`; they are not
  removed from the denominator.
- Do not combine baseline and lever runs into a projected union score.
- Do not reimplement pass@k or standard error from memory. Reuse or port the
  pinned upstream calculator and prove parity against an official submission.
- Full coverage and standard settings are separate from model quality. Report
  incomplete/nonstandard runs as such.

### Trial ownership

- Harbor owns benchmark trials via `-k`.
- Quanta's terminal brain remains one clean attempt.
- The terminal-only `QUANTA_TB_BEST_OF_N` wrapper is runtime-dead today and must
  not become a second sampling layer. Remove it during retirement.
- The generic SWE-bench sampler under `src/apps/bench` is out of scope.

### Reproducibility and promotion

- Pin Harbor and the dataset ref. Do not use a VCS `main` dependency or `latest`
  as promotable evidence.
- Every report carries Quanta SHA, dirty state, agent version, Harbor version,
  dataset ref, provider/model, reasoning effort, profile, sandbox, and execution
  budgets.
- A dirty run may be used for development but is not promotable.
- No secrets may enter Docker layers, reports, logs, ATIF trajectories, or docs.

### Main-direct safety

- Do not reset, stash, overwrite, or silently include the three pre-existing user
  modifications.
- Before each commit, stage explicit paths and inspect `git diff --cached`.
- A green dirty-overlay run is not a committed-current-SHA receipt.
- Do not push unless separately authorized.

## Shared foundation gates

Terminal implementation consumes these shared gates rather than recreating them:

| Gate | Required before |
|---|---|
| [BFND-01](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md) | TB21-00A suite registration and all command/config work |
| [BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md) | TB21-04 report integration |
| [BFND-03](../../aug-21-bench-foundation/tickets/BFND-03-dashboard-projectors.md) | TB21-05 dashboard projection |

Jun-30 T4 is not a Terminal prerequisite. It remains an internal SWE family
registry concern used by ProMax.

## Ticket order

| ID | Title | Priority | Size | Depends on | Live cost |
|---|---|---:|---:|---|---:|
| [TB21-00](./TB21-00-main-snapshot-and-retirement-manifest.md) | Main snapshot and retirement manifest | P0 | S | — | none |
| [TB21-00A](./TB21-00A-benchmark-suite-extension-port.md) | Terminal suite registration | P0 | M | TB21-00, BFND-01 | none |
| [TB21-01](./TB21-01-harbor-pin-and-doctor.md) | Pinned Harbor runtime and doctor | P0 | M | TB21-00A | one import/sandbox probe |
| [TB21-02](./TB21-02-agent-provenance-reasoning-atif.md) | Agent provenance, reasoning, ATIF | P0 | L | TB21-01 | one fake + one live trajectory |
| [TB21-03](./TB21-03-command-profile-and-manifest.md) | Unified command/profile/manifest SSOT | P0 | M | TB21-00A, TB21-01, TB21-02 | 1-task oracle + 3-task canary |
| [TB21-04](./TB21-04-lossless-report-and-official-scoring.md) | Lossless reports and official scoring | P0 | L | BFND-02, TB21-02, TB21-03 | fixture-first; reuse canary |
| [TB21-05](./TB21-05-dashboard-2-1-cutover.md) | Dashboard 2.1 cutover | P0 | L | BFND-03, TB21-04 | none beyond receipts |
| [TB21-06](./TB21-06-retire-2-0-and-refresh-smoke.md) | Remove TB2.0 and refresh smoke | P1 | M | TB21-00A, TB21-03, TB21-05 | reuse canary |
| [TB21-07](./TB21-07-canary-k1-k5-receipt-closure.md) | Canary, k=1, k=5 receipt closure | P0 | L | TB21-00..06, including TB21-00A | high |

BFND generic changes land once before their Terminal consumers. Execution is
otherwise serial through TB21-05 because the report contract is the dashboard's
input authority. TB21-06 retirement occurs only after the 2.1 canary is real and
the new dashboard can render it. TB21-07 is the only ticket allowed to spend on a
full benchmark.

## Global proof ladder

Use the cheapest authoritative rail that can falsify the current layer:

```sh
# adapter-local
python3 -m pytest -q adapters/terminal-bench/tests

# terminal brain and contract
bun test src/apps/terminal/*.test.ts

# unified bench suite/command/report
bun test \
  src/apps/bench/benchmark-suite.test.ts \
  src/apps/bench/commands/terminal.test.ts \
  src/apps/bench/terminal

# dashboard projection only
bun test \
  tools/leaderboard-dashboard/projectors/terminal-bench.test.ts \
  tools/leaderboard-dashboard/server.test.ts

# repo structural rails
bun run typecheck
bun run lint
git diff --check
```

Then escalate through doctor -> import smoke -> one oracle task -> three-task
canary -> 89-task `k=1` -> 89-task `k=5`.

Do not jump to a full run to discover a schema, import, auth, or dashboard bug.

## Campaign-level definition of done

- Active source/docs/scripts contain no TB2.0 dataset or scoring authority.
- Terminal-Bench is registered as a suite, never as a SWE `datasetFamily`.
- Shared BFND suite/report/projector contracts are consumed without local copies.
- All paid commands enter through `quanta-bench terminal ...`.
- Harbor and dataset are pinned and recorded in a lock/manifest.
- Quanta agent version and reasoning effort are visible to Harbor and receipts.
- Successful trials have auditable ATIF trajectory paths.
- The report retains 445 distinct trial receipts for a complete `k=5` run.
- Local accuracy, standard error, and pass@k match the pinned upstream calculator.
- Terminal reports use the existing canonical report writer and result mirror.
- Dashboard shows Terminal-Bench 2.1 only, with per-profile trial-rate metrics.
- Dashboard suite projection contains no second scorer or any-pass headline fold.
- Old versionless reports cannot affect cards, matrices, filters, or leaderboards.
- The full `k=1` run has no unexplained missing tasks/trials before `k=5` starts.
- Final evidence names the exact clean committed SHA. No push is implied.

## External authority

- Dataset and run shape:
  <https://github.com/harbor-framework/terminal-bench-2-1>
- Custom agent interface:
  <https://www.harborframework.com/docs/agents>
- Official coverage, error, trajectory, and submission rules:
  <https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/SUBMIT.md>
- Official submission schema example:
  <https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/submissions/2026-07-10-gpt-5-6-luna-max-codex.json>

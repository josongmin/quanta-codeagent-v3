# TB21-04 — lossless report and official scoring

**Priority:** P0
**Size:** L
**Depends on:** shared BFND-02; TB21-02, TB21-03
**Parallelizable:** no
**Live benchmark cost:** fixture-first; reuse the canary

## Goal

Replace the current task-level any-pass report with a trial-lossless TB2.1 report
and prove metric parity with the pinned upstream leaderboard calculator while
retaining the existing canonical bench writer and result mirror.

## Current defect

`tools/leaderboard-dashboard/tb-report-emit.ts` currently:

- deduplicates trials to one row per task;
- lets any pass win;
- loses trial IDs and per-trial cost/token/trajectory data;
- excludes some infrastructure outcomes downstream;
- cannot prove `k=5` coverage;
- produces metrics not comparable to the official leaderboard.

That schema must be replaced, not extended with another optional field while
retaining the old fold.

## Shared report ownership consumed

Shared [BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md)
owns the `CanonicalBenchReport` union, serialization, and canonical
`~/.quanta/bench/results` mirror. This ticket implements only the Terminal branch
builder/parser/scorer and calls that writer.

```ts
interface TerminalBenchReport {
  schemaVersion: "terminal-bench-report/v2"
  benchmarkSuite: "terminal-bench"
  benchmarkVersion: "2.1"
  dataset: "terminal-bench/terminal-bench-2-1"
  datasetRef: string
  // provenance, admission, metrics, and lossless trials
}
```

The SWE branch, including a possible `promax` family and generic official-grade
totals, is outside this ticket. Terminal reports must not carry `datasetFamily`.

Terminal raw-result discovery, parsing, classification, and scoring live under
`src/apps/bench/terminal/`; the final typed object is written through the
canonical writer. `tools/leaderboard-dashboard/tb-report-emit.ts` is deleted, or
temporarily reduced to a thin adapter that calls the canonical builder/writer and
is removed in TB21-06. It may not own another schema, sink, or scorer.

## Canonical report shape

The new report must include:

- manifest/provenance from TB21-03;
- Harbor job IDs/source paths;
- one receipt per distinct trial ID;
- task ID and canonical task version/ref;
- raw numeric reward used for scoring;
- error/termination classification;
- start/end/duration;
- input/cached-input/output tokens where reported;
- cost;
- trajectory path and ATIF validity;
- verification/self-test metadata as supplemental Quanta facts;
- completeness and standard-config admission;
- metrics computed from the preserved trials.

Do not copy full trajectory content into the summary report.

## Outcome taxonomy

At minimum distinguish:

- `graded_pass`;
- `graded_fail`;
- `agent_timeout`;
- `agent_crash`;
- `environment_error`;
- `verifier_error`;
- `missing_reward`;
- `malformed_result`.

For the official-shaped score, every admitted trial contributes its actual reward;
errored/disqualified trials contribute zero under the upstream rules. Diagnostic
taxonomy does not authorize denominator removal.

Missing or malformed trial data makes the local receipt incomplete. Never invent
a zero or pass merely to reach the expected trial count.

## Scoring authority

1. Pin the upstream leaderboard code/ref that calculates:
   - accuracy;
   - accuracy standard error;
   - pass@2 through pass@5;
   - trial coverage and disqualification effects.
2. Reuse it directly or port the minimal pure functions with attribution and exact
   fixtures.
3. Run the local scorer against at least one official submission JSON and prove
   the displayed metrics match its checked-in values within the upstream rounding
   contract.
4. Add a red-on-injection test: mutate one reward/error/disqualification and prove
   the expected metric changes.

Do not derive formulas from the displayed percentages alone.

## Completeness admission

For the canonical full dataset:

- read the expected task set/count from the pinned dataset manifest;
- `k=1` expects one admitted trial per task;
- `k=5` expects five admitted trials per task (currently 445 total);
- duplicate trial IDs are rejected;
- unknown task IDs and wrong task versions are rejected;
- successful trials without required trajectory paths make the run
  non-promotable;
- nonstandard timeout/resource overrides make the run nonstandard, not silently
  official.

## RED rails

- Two trials for one task, one pass and one fail, must remain two receipts.
- An error trial must lower official-shaped accuracy instead of disappearing.
- Baseline and lever reports must not union into one metric.
- Duplicate trial IDs must fail.
- Wrong/missing dataset ref must fail.
- Missing reward must produce incomplete, not a fabricated miss.
- Old versionless TB2.0 reports must be rejected/quarantined.
- A 444-trial `k=5` report must not render as complete.
- Official-submission parity fixture must go red when a reward is injected.
- The Terminal report command must make a live `writeReport(` call into the
  canonical owner; an import-only or second `Bun.write` implementation fails.

## Expected owner files

- BFND-02-owned `src/runner/batch/report.ts` types/writer as a consumer only
- `src/apps/bench/terminal/{harbor-results,report,scoring}.ts` and focused tests
- `tools/leaderboard-dashboard/tb-report-emit.ts` (delete or thin-delegate only)
- report-schema validation fixtures

Keep filesystem scanning separate from pure parsing/classification/scoring.
Dashboard code is not an allowed report/scoring owner.

The canonical-writer structural guard must require a call pattern, assert a
known Terminal report-command floor, and prove red-on-injection by deleting the
call in a synthetic fixture. A bare `writeReport` import is not proof.

## Proof rails

```sh
bun test src/apps/bench/terminal/report.test.ts
bun test src/apps/bench/terminal/scoring.test.ts
bun test tests/unit/apps/bench/batch-report-schema-parity.test.ts
bun run typecheck
bun run lint
git diff --check
```

Then emit from the three-task canary and manually reconcile every trial directory
against the report. Counts, rewards, errors, durations, and trajectory paths must
match.

## Definition of done

- No trial is collapsed or silently excluded.
- Local metrics match the pinned upstream calculator.
- Every Terminal report is serialized and mirrored by the existing canonical
  bench writer; there is no second active report root.
- SWE/ProMax reports continue through their separate BFND-02 union branch.
- Completeness and standard-config admission are explicit.
- Versionless TB2.0 reports cannot enter the new report set.
- Canary raw tree -> report is bijective by trial ID.

## Stop rule

If Harbor's current on-disk/job schema is not stable enough to locate a trial ID,
reward, and task version authoritatively, stop. Do not use directory-name or
duration heuristics as scoring authority.

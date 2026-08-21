# TB21-05 — dashboard Terminal-Bench 2.1 cutover

**Priority:** P0
**Size:** L
**Depends on:** shared BFND-03; TB21-04
**Parallelizable:** no
**Live benchmark cost:** none beyond existing receipts

## Goal

Make the dashboard a faithful view of versioned TB2.1 trial receipts and official
leaderboard submissions. Remove the TB2.0 per-task matrix and optimistic any-pass
projection instead of relabeling them. Integrate through a suite projector rather
than adding more Terminal-specific branches to `server.ts`.

## Shared dashboard architecture consumed

Shared [BFND-03](../../aug-21-bench-foundation/tickets/BFND-03-dashboard-projectors.md)
owns the registry, generic shell extraction, and SWE/Terminal dispatch. This
ticket implements only Terminal projection and the official-data importer:

```text
tools/leaderboard-dashboard/
  projectors/
    terminal-bench.ts
  importers/
    terminal-bench-official.ts
  server.ts                         # discovery + HTTP/UI composition only
```

The Terminal projector registers with the BFND registry and consumes the
metrics/admission already produced by TB21-04. ProMax rendering remains inside
the SWE projector and is not touched here.

Do not retain or add raw
`(report.datasetFamily || "verified") === "terminal-bench"` branches. Terminal
selection is by `benchmarkSuite === "terminal-bench"`; `datasetFamily` filters
remain inside the SWE projector.

## Required UI changes

### Benchmark selector and provenance

- Label the suite `Terminal-Bench 2.1`.
- Display dataset ref, Harbor version, Quanta SHA/dirty state, agent version,
  provider/model, reasoning effort, profile, sandbox, and standard-config status.
- Refuse or quarantine versionless/wrong-version reports with a visible diagnostic.

### Summary cards

For each run/profile independently, show:

- accuracy and standard error;
- trials present / expected;
- task coverage;
- pass@2..5 when `k` supports it;
- graded pass/fail and error counts;
- total cost and token totals;
- average trial duration;
- promotable/complete/standard status.

Do not show `baseline ∪ levers` projection or a solved-task any-pass score as the
headline metric.

### Per-task matrix

Show the current run's trial distribution:

- reward count such as `3/5 (60%)`;
- trial/error count;
- average duration/cost where available;
- links to job/trial/trajectory where safe;
- filters for pass-rate, error type, missing trials, and incomplete coverage.

Any-pass may be a clearly secondary diagnostic field, never the score.

### Official competitor view

Replace `rawdata/tb-pertask.md` and its HF/TB2.0 parser with a pinned importer over
the official TB2.1 `leaderboard/submissions/*.json` files.

Required global columns:

- agent and model;
- reasoning effort;
- accuracy +/- SE;
- pass@2..5;
- trial count;
- total cost;
- average duration;
- reward-hack/disqualification metric and source link;
- upstream commit/ref and refresh timestamp.

Official submission JSON does not itself expose a per-task competitor matrix.
Render external per-task rates only if an authoritative Hub/trial import is added
with pinned provenance. Otherwise omit the column; never carry forward TB2.0 rates
or infer task outcomes from global metrics.

The importer is an explicit offline refresh tool:

- require an immutable upstream commit/ref; reject `main`/`latest` as a committed
  comparison snapshot;
- store source URLs, upstream commit, dataset ref, and refresh timestamp beside
  the normalized payload;
- validate/escape all external fields before writing;
- leave dashboard startup network-free and deterministic;
- never launch Harbor or write Quanta run reports.

## Data boundaries

- `DATA.tb` becomes a versioned 2.1 dashboard payload, not parsed old markdown.
- Reports from different dataset refs, profiles, models, efforts, or `k` values do
  not coalesce into one campaign score.
- The grouping key includes `benchmarkSuite`, `benchmarkVersion`, `datasetRef`,
  profile, provider/model, reasoning effort, sandbox, `k`, and standard-config
  admission. Missing required identity quarantines the report.
- The dashboard consumes scorer output from TB21-04; it does not recalculate a
  second metric in browser JavaScript.
- A background refresh preserves filters/focus but never merges stale and current
  dataset refs.

## RED rails

- Existing tests expecting `any-pass` must be replaced and initially fail.
- A pass+fail pair for one task renders `1/2`, not a single check mark.
- A crash trial remains in official-shaped denominator/cards.
- A versionless old report cannot create the Terminal-Bench selector or badge.
- A report marked `datasetFamily: "terminal-bench"` is quarantined as invalid.
- Two profiles remain two scored rows.
- Dataset-ref mismatch remains two groups or quarantine, never one group.
- Missing external per-task data renders `—`, not a stale 2.0 value.
- An HTML/script hostile field from external JSON remains escaped.
- Official submission fixture renders the checked-in accuracy/pass@k/cost values.

## Expected owner files

- `tools/leaderboard-dashboard/server.ts`
- `tools/leaderboard-dashboard/server.test.ts`
- BFND-03 registry/SWE projector as existing consumed owners
- `tools/leaderboard-dashboard/projectors/terminal-bench.ts`
- focused Terminal projector tests plus shared dispatch fixtures
- `tools/leaderboard-dashboard/tb-pertask.ts` (delete/replace)
- `tools/leaderboard-dashboard/rawdata/tb-pertask.md` (delete)
- `tools/leaderboard-dashboard/importers/terminal-bench-official.ts` and pinned fixtures
- `tools/leaderboard-dashboard/external-comparison.ts` only if its family mapping
  becomes the right shared owner

Avoid growing `server.ts` with another large embedded parser. Put pure TB2.1 data
and scoring projections in focused modules and keep the server a composer. Since
`server.ts` is already a god-module, this cutover must extract the touched suite
logic and reduce it; do not add an allowlist entry.

## Proof rails

```sh
bun test \
  tools/leaderboard-dashboard/server.test.ts \
  tools/leaderboard-dashboard/projectors/swe-bench.test.ts \
  tools/leaderboard-dashboard/projectors/terminal-bench.test.ts \
  tools/leaderboard-dashboard/importers/terminal-bench-official.test.ts
bun run tools/leaderboard-dashboard/importers/terminal-bench-official.ts -- \
  --upstream-ref <immutable-commit> --dry-run
bun run typecheck
bun run lint
git diff --check
```

Render the dashboard against:

1. no TB reports;
2. one complete canary report;
3. an incomplete report;
4. a legacy versionless report;
5. two distinct profiles;
6. a pinned official-submission fixture.

## Definition of done

- The active UI says Terminal-Bench 2.1 and shows exact provenance.
- Suite dispatch is registry-based; the server contains no Terminal-as-dataset-family branch.
- Cards and per-task rows use trial-rate/official semantics.
- Legacy reports and TB2.0 competitor data cannot influence any visible score.
- Official global comparison is source-pinned and refreshable.
- Missing authoritative data fails closed to `—`.

## Stop rule

If the UI needs a second scoring formula to render a card, stop and move that
calculation into the TB21-04 scorer. The dashboard must display receipts, not
become another grading authority.

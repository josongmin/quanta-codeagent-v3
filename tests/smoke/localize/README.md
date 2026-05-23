# `localize` calibration corpus

Empirical recall@K / MRR measurement for the `localize` tool. Lives outside the
unit-test gate on purpose — this is **calibration**, not regression CI.

## Purpose

R-Phase9 (and every future change to `src/tool/localize/`) modifies a ranking
algorithm. Algorithm changes need data to justify or refute them, per the
`[no-heuristics-only-validated]` discipline: a measurable corpus + a one-line
re-measure makes "did this actually help?" answerable in seconds rather than
vibes.

## Methodology

For each entry in `corpus.json` the script drives `localizeTool` with
`max_results: 20`, parses the ranked file list out of `result.output`
(indented `<file>:<line>  <snippet>` rows, deduplicated by file with
first-occurrence-wins), and computes:

- **recall@K** for a query = `|expected ∩ first_K_predicted_files| / |expected|`
- **MRR contribution** for a query = `1 / rank_of_first_expected` (1-based);
  `0` when no expected file appears anywhere in the prediction
- **Aggregate** = arithmetic mean across every query

Output is `baseline.json` (schema: see `MeasureReport` in `measure.ts`).

One normalization applied to predictions before scoring: absolute paths are
relativized to `cwd`, and the two measurement-instrument files
(`tests/smoke/localize/corpus.json` and `tests/smoke/localize/baseline.json`)
are dropped from the prediction list — they contain every query verbatim and
would otherwise top their own rankings, which is contamination, not signal.
No other re-ranking or filtering is performed.

## Capture a measurement

```sh
bun run tests/smoke/localize/measure.ts > tests/smoke/localize/baseline.json
```

The `git_sha` field pins the measurement to a tree, so two snapshots can be
unambiguously diffed.

## Compare two measurements

```sh
diff <(jq .aggregate before.json) <(jq .aggregate after.json)
# or, per-query:
jq -r '.queries[] | "\(.id)\t\(.rank_of_first_expected)\t\(."recall@3")"' before.json
jq -r '.queries[] | "\(.id)\t\(.rank_of_first_expected)\t\(."recall@3")"' after.json
```

## Caveats — read before celebrating any delta

The corpus is small (14 entries). Per-query noise is real — flipping a single
query from rank 4 → rank 2 swings aggregate `recall@3` by ~7 percentage points.
**Justification rule for a `localize` PR**: aggregate `recall@3` and `MRR` must
both improve, AND no individual `recall@3` may drop by more than `0.20` without
explicit rationale in the PR description.

This is **not** wired into CI. Per-query churn under noise would either gate on
nothing useful (tolerance too loose) or fail spuriously (tolerance too tight).
Promote to CI only after the corpus grows past ~50 entries; until then, the
PR-time justification rule is the gate.

## Files

- `corpus.json` — 14-entry hand-labeled query → owner-file ground truth.
  Every `expected_files` entry was verified to exist on disk at corpus
  creation.
- `measure.ts` — bun driver + the four pure helpers (`parseRanking`,
  `recallAtK`, `mrr`, `aggregate`) that `tests/unit/localize-measure.test.ts`
  exercises.
- `baseline.json` — captured baseline on current main HEAD. Replace by
  re-running the capture command above against a new tree.

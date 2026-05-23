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
relativized to `cwd`, and three measurement-instrument files
(`tests/smoke/localize/corpus.json`, `tests/smoke/localize/baseline.json`, and
`tests/smoke/localize/post-r-phase9.json`) are dropped from the prediction list
— they contain every query verbatim and would otherwise top their own
rankings, which is contamination, not signal. No other re-ranking or
filtering is performed.

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

The corpus is moderate (44 entries as of R-Phase10, up from the original 14).
Per-query noise is still real but no longer dominant: with `n = 44`, a binomial
95% CI on aggregate `recall@K` is roughly `±0.15`, so an aggregate-delta of
`>0.05` is now statistically meaningful (and `>0.10` is unambiguous). Flipping
a single query from rank 4 → rank 2 still swings aggregate `recall@3` by
~2.3 percentage points — within noise — so per-query churn alone is never
sufficient justification.

**Justification rule for a `localize` PR**: aggregate `recall@3` and `MRR` must
both improve, AND no individual `recall@3` may drop by more than `0.20` without
explicit rationale in the PR description.

This is **not** wired into CI yet. With n=44 we are closer to the n≥50
promotion threshold but not over it; one more expansion round (or a stable
two-snapshot streak) clears the bar. Until then, the PR-time justification
rule is the gate.

## Query classes covered (R-Phase10)

The expanded corpus spans 8 deliberately-distinct query classes to keep
aggregate signal from concentrating in one ranking failure mode:

1. **Symbol** — single unique exported identifier (positive controls).
2. **Behavioral** — natural-language description of what a module DOES.
3. **Cross-file / multi-owner** — answer is a 2-3-file set, not a single file.
4. **Acronym / initialism / domain term** — MCP, JSONL, OTel, LSP.
5. **Negation / disambiguation traps** — query matches several plausible
   owners; canonical one is expected (tests def-pattern boost).
6. **Edge cases** — sub-3-char query, 23-word natural-language, non-ASCII.
7. **Error / stack-trace style** — paraphrased fault-localization queries.
8. **Test-file-targeted** — answer is `tests/unit/*.test.ts`, probing the
   `test: -2` tier penalty.

## Files

- `corpus.json` — 44-entry hand-labeled query → owner-file ground truth
  (R-Phase10 expansion from the original 14). Every `expected_files` entry
  was verified to exist on disk at corpus creation.
- `measure.ts` — bun driver + the four pure helpers (`parseRanking`,
  `recallAtK`, `mrr`, `aggregate`) that `tests/unit/localize-measure.test.ts`
  exercises.
- `baseline.json` — captured baseline on current main HEAD. Replace by
  re-running the capture command above against a new tree.

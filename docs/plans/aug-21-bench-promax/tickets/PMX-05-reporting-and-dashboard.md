# PMX-05 - ProMax receipt, honest denominator, and dashboard partition

**Priority:** P0

**Depends on:** PMX-03 receipt schema; shared BFND-02 and BFND-03

**May overlap:** PMX-04 using fixtures

## Goal

Make report JSON and the dashboard show both model performance and measurement
coverage without relying on the upstream golden-filtered headline.

## Shared report owner consumed

[BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md)
owns the `CanonicalBenchReport` union, writer, mirror, and top-level suite
identity. PMX-05 adds one generic official-grade aggregation function and types
to the `SweBenchReport` branch under `src/runner/batch/report.ts` or a cohesive
sibling. It consumes PMX-03's generic receipts and is the only authority for
disposition totals and rates.

- `buildReport` persists the totals and per-instance dispositions.
- CLI/markdown output reads the persisted/canonical totals.
- the BFND-03 SWE projector groups its branch by `datasetFamily` and renders
  those totals; it does not recompute them from filtered rows.
- existing `resolvedTotals`/`scoreTotals` remain compatibility outputs for legacy
  reports, but ProMax headline values are derived from the new generic official-
  grade aggregation exactly once.

Do not create a ProMax-only summary algorithm, report writer, or top-level report
schema in `apps/bench`, the dashboard, or campaign tooling. Terminal reports and
Harbor trial metrics remain the other BFND-02 branch.

## Required totals

Add a generic `OfficialGradeTotals` summary used first by ProMax:

```text
assigned
attempted
grading_valid
resolved
model_miss
infra_invalid
ambiguous
missing
official_valid_rate
coverage
raw_rate
by_language
by_reason
```

Family-specific metadata may extend the receipt, but the covering partition and
rate formulas are generic and must work for any future official grader profile.

Enforce the covering partition:

```text
assigned = resolved + model_miss + infra_invalid + ambiguous + missing
attempted = assigned - missing
grading_valid = resolved + model_miss
```

`official_valid_rate`, `coverage`, and `raw_rate` are always adjacent in JSON,
CLI summary, markdown export, and dashboard. Zero denominators render explicitly
as unavailable, not `0%` success.

## Per-instance receipt

Expose compact fields:

- four-state outcome and reason subtype;
- language;
- official model/golden final result;
- raw official artifact path and digest;
- prediction digest;
- source/derived golden and eval digests;
- upstream evaluator commit/digest;
- source image, registry digest, local image ID, platform;
- Quanta SHA and dirty state;
- provider/model/reasoning effort/preset/turn-token-wall budgets;
- run/chunk/box identifiers and attempt count.

Do not inline full stdout/stderr into the main report if that makes it unbounded;
retain immutable artifact files and link them by digest.

PMX-05 serializes the disposition already decided by PMX-03. It may validate the
covering partition but must not map raw upstream reasons again.

## Dashboard rules

- `benchmarkSuite:"swe-bench"` selects the BFND-03 SWE projector;
- `datasetFamily:"promax"` is a separate campaign partition from `pro`;
- no external baseline mapping is invented until a compatible official result
  source is defined;
- headline cards show assigned and coverage beside score;
- language table uses the same assigned manifest, including invalid/missing rows;
- reason drilldown exposes golden failures, model timeouts, image failures, and
  human-review cases;
- a filter or display bug cannot drop invalid rows from assigned totals;
- dashboard cards/tables consume the report's canonical totals, and any
  row-derived diagnostic is visibly non-authoritative.

Implement ProMax rendering as one helper registration in BFND-03's UI-only SWE
family-view registry, for example
`tools/leaderboard-dashboard/projectors/swe-bench/promax.ts`. Do not add a
top-level `promax` projector, edit runtime T4 behavior from the dashboard, or grow
`tools/leaderboard-dashboard/server.ts`. The helper accepts already-aggregated
`OfficialGradeTotals`; it contains no denominator formulas.

## Tests

- canonical example: 170 assigned, 65 resolved, 103 model misses, 2 infra,
  0 ambiguous, 0 missing -> valid rate `65/168`, coverage `168/170`, raw rate
  `65/170`;
- raising infra while holding resolved fixed lowers coverage and cannot improve
  raw rate;
- missing and ambiguous remain in assigned but outside grading-valid;
- per-language totals sum to campaign totals;
- `pro` and `promax` never group together;
- adding ProMax requires one SWE family-view registration and no scattered
  `datasetFamily === "promax"` branch;
- ProMax and Terminal never share a suite projector or campaign key;
- `benchmarkSuite:"promax"` is rejected;
- report round-trip preserves every provenance digest;
- report, CLI, markdown, and dashboard show byte-identical totals from the same
  canonical fixture without each surface aggregating raw rows;
- red-on-injection drops one assigned row and fails the partition assertion;
- red-on-injection mutates a dashboard filter and proves the persisted assigned
  total remains unchanged;
- legacy reports without ProMax fields render unchanged.
- BFND-02 writer/mirror and Terminal report round-trips remain unchanged.

## Definition of done

An operator can determine score, coverage, invalid reasons, exact artifacts, and
replay inputs from the report without reading console logs or trusting the
upstream printed denominator. There is one aggregation owner and every display
surface consumes its persisted result.
The report is a `swe-bench/promax` branch of BFND-02 and the UI is a ProMax
family helper under BFND-03's SWE projector; neither becomes a parallel owner.

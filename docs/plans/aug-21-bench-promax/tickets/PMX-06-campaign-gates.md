# PMX-06 - staged campaign gates and promotion policy

**Priority:** P0 for campaign readiness

**Depends on:** README Foundation gate; BFND-01..03; PMX-00 through PMX-05

## Goal

Close the integration with the cheapest authoritative sequence and forbid an
expensive Full-170 model run on an unverified evaluator/image fleet.

## Frozen campaign inputs

Before PMX-7, record:

- PMX manifest digests and ordered nested sample IDs;
- exact Quanta clean SHA;
- control and candidate preset names plus resolved knob snapshots;
- provider, model, reasoning effort, turn/token/wall budgets;
- patch-generation and grading concurrency;
- continuation rule from PMX-40 to Full-170;
- retry and upstream-exception policy.
- exact source-owner inventory proving one typed config resolver, one family
  profile registry, one ProMax harness adapter, one generic remote grade-receipt
  contract, one official-grade aggregation function, one canonical report writer,
  and one SWE-projector ProMax registration;
- baseline and final counts of raw family env reads, `family === "promax"`
  branches outside the registered profile, and legacy verdict-bucket consumers.

Do not use the implicit current default preset. Integration smoke uses an
explicit portable preset that does not require the current Pyright-only strict
remote gate. Product A/B arms are separately named and frozen.

## Gate 1 - PMX-7 gold

Use the guaranteed apply-failing model sentinel from PMX-03 on the seven PMX-7
IDs. The gate requires:

- 7/7 attempted;
- 7/7 sentinel model result `apply_failed`;
- 7/7 golden result `success`;
- 7/7 image and upstream provenance receipts;
- no trust in top-level `passed`.

## Gate 2 - same PMX-7 model smoke

Run Quanta on the exact same seven IDs and cached images. Require:

- 7/7 assigned and attempted;
- 7/7 grading-valid;
- zero infra-invalid, ambiguous, or missing;
- agent/grader leakage check enabled;
- full model/evaluator/image/Quanta provenance.

Score is diagnostic at this gate; integration validity is the decision.

## Gate 3 - PMX-14 canary

Add the second deterministic ID per language. Require 14/14 grading-valid and no
unknown outcome reason before larger inference.

## Gate 4 - PMX-40 paired experiment

Run the predeclared control and candidate over the same ordered PMX-40 manifest,
images, model, reasoning effort, and budgets. Preserve paired per-ID outcomes,
cost, turns, and wall time.

The continuation rule must be written before results exist. If it says there is
no useful signal or the cost/quality tradeoff is unacceptable, stop; do not run
Full-170 to search for a favorable aggregate.

## Gate 5 - PMX-170 gold preflight

Before any Full-170 model inference, run the sentinel across all 170 IDs.
Require:

- 170/170 evaluator attempts;
- 170/170 image provenance receipts;
- 170/170 golden `success`;
- zero schema-unknown outcomes.

If upstream defects prevent 170/170, create a versioned exception manifest with
instance ID, exact raw receipt, upstream issue/reference, owner, and disposition.
Do not delete exceptions from assigned. Campaign readiness then reports both
`170 assigned` and the exact valid/exception coverage.

## Gate 6 - PMX-170 model

Allowed only after Gates 1-5 and the PMX-40 continuation rule pass. Run from a
clean exact SHA and preserve chunk coverage. A lost or partial chunk is requeued
within the frozen retry policy; exhausted rows remain `missing`, never model
misses.

## Verification rails before live spend

```sh
bun run typecheck:all
bun run lint
bun test src/apps/bench/benchmark-suite.test.ts
bun test src/apps/bench/promax src/apps/bench/dataset-family.test.ts
bun test src/apps/bench/remote/box-session
bun test src/runner/batch/report-r4.test.ts
bun test tools/leaderboard-dashboard/projectors tools/leaderboard-dashboard/server.test.ts
bun test tests/unit/god-code-ratchet.test.ts
```

Use actual paths after implementation; no command may pass over an empty test
selection. Add anti-vacuum count assertions where directory selection is used.

Also run a source-owner audit. Exact patterns may evolve with the implementation,
but the acceptance report must include equivalent receipts for:

```sh
# forbidden hierarchy and scattered family behavior
rg -n 'benchmarkSuite.{0,20}promax|datasetFamily.{0,20}terminal-bench|family.*promax' \
  src/apps/bench src/runner/batch tools/leaderboard-dashboard

# canonical definitions: each definition count must be exactly one
rg -n '^export (interface|type) OfficialGrade(Receipt|Disposition|Totals)' \
  src/runner/batch/eval src/runner/batch/report*

# live composition calls, not imports/comments
rg -n 'register.*Profile\\s*\\(|aggregateOfficialGrades\\s*\\(|writeReport\\s*\\(|register.*Projector\\s*\\(' \
  src/apps/bench src/runner/batch tools/leaderboard-dashboard

# no parallel ProMax evaluator/corpus/config/report runner outside declared owners
find src/apps/bench tools -type f | sort | rg 'promax|profiles|harness|projectors'
```

The report classifies every hit as canonical definition, composition wiring,
process-boundary serialization, compatibility projection, or remaining debt.
Unclassified duplicates block live spend.
The executable owner test asserts exact definition/registration counts, a
non-zero known-consumer floor, and red-on-injection for a duplicate profile,
aggregator, writer call bypass, and top-level ProMax projector. The `rg` inventory
alone is not acceptance proof.

## Integration done

- static/hermetic rails green;
- BFND-01..03 and T2/T4 are production-wired and the source-owner audit has no
  unclassified duplicate owner;
- PMX-7 gold and model gates green;
- PMX-14 is 14/14 grading-valid on the current clean SHA.

## Campaign ready

- PMX-40 paired result is reproducible and satisfies its predeclared continuation
  rule;
- PMX-170 gold preflight succeeds or has a reviewed versioned exception manifest;
- every assigned ID has complete upstream/image/Quanta/model provenance;
- reporting shows valid rate, coverage, and raw rate together.

## Not complete

- parser/evaluator unit tests without a live Docker receipt;
- a ProMax-specific config registry, corpus runner, remote verdict parser, or
  dashboard denominator existing beside the canonical owner;
- a top-level `promax` suite/projector or a ProMax report writer beside BFND;
- an in-process argv-to-env family bridge used as the typed-config implementation;
- a dirty-overlay canary;
- a PMX-40 point estimate without paired receipts;
- a Full-170 model run launched before Gold-170;
- a score that omits missing/invalid rows or merges ProMax with Scale Pro.

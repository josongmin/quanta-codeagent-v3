# T-REG-03 — static witness tests instead of discovered-regression authority

## Goal

Replace magic-score discovered regression authority with static-engine-backed witness-test generation. The static
ranker may choose tests to run; only the executed result may reject.

## Files

- `src/runner/batch/eval/impacted-test-discovery.ts`
- `src/runner/batch/eval/repo-regression-discovery-adapter.ts`
- `src/runner/batch/eval/regression-oracle.ts`
- `src/tool/find-refs/index.ts`
- `src/tool/lsp_nav/index.ts`
- `tests/unit/impacted-test-discovery.test.ts`
- `tests/unit/repo-regression-discovery-adapter.test.ts`
- `tests/unit/rematerialize.test.ts`

## Implementation

- Split impacted test discovery into two layers:
  - `WitnessTestCandidateBuilder`: static candidate generation.
  - `ExecutedWitnessResult`: actual test execution result.
- Remove magic score values from verdict authority.
- If score values remain, make them ordering-only and telemetry-visible.
- `WitnessTestCandidateBuilder`는 optional helper다. simpler executed-witness path가 같은 이상 성능/비용
  특성을 내면 builder를 유지하지 말고 제거한다.
- Prefer evidence sources in this order:
  - changed source file to nearby test mirror.
  - `find_references`/import references from tests to source.
  - repo test naming conventions.
  - explicit verification plan tests.
- Store why each witness test was chosen:
  - `mirrorPath`.
  - `testImportsSource`.
  - `referenceToChangedSymbol`.
  - `verificationPlan`.
- `regressionGreen=false` is only produced after executing selected tests on the patched tree.
- Empty witness set yields `null`, not reject.
- Prove the witness suite is non-oracle by construction, not just by "we don't
  import PASS_TO_PASS":
  - the builder takes a typed input that structurally has no field for
    `PASS_TO_PASS` / `FAIL_TO_PASS` / `test_patch` / held-out grading labels.
  - a red-on-injection test feeds those oracle labels in through any reachable
    surface and asserts the produced witness candidate set is byte-identical to
    the no-oracle run. Static "not imported" grep misses leakage via file reads or
    config; the injection test does not.

## Hellgate

- Changing rank weights cannot change admissibility unless the executed test set changes and fails.
- Empty witness candidates fail open.
- A failing executed witness test rejects.
- A static candidate that was never executed cannot reject.
- PASS_TO_PASS or hidden labels are not imported by engine code.
- Injecting oracle labels (`PASS_TO_PASS`, `FAIL_TO_PASS`, `test_patch`) through any
  reachable surface leaves the witness candidate set byte-identical (red-on-injection).

## Done

- Hard regression rejection is backed by an execution receipt.
- The old score table is not part of clean authority.
- Telemetry shows candidate tests, source evidence, executed tests, and failures separately.
- Builder / rank telemetry는 measurable utility가 있을 때만 남는다.

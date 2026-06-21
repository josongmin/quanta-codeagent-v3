# T-CON-10 — public contract bundle

## Goal

Replace instance-shaped selector hints with a generic typed bundle of public contracts derived from public issue
text, public tests, validated repros, and static witnesses.

## Files

- `src/agent/verification-plan/extract-issue-declared-expected.ts`
- `src/agent/verification-plan/build.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/selection-executor.ts`
- optional: `src/runner/batch/eval/public-contract-bundle.ts`
- optional: `src/runner/batch/eval/public-contract-types.ts`
- `tests/unit/selection-executor.test.ts`
- `tests/unit/verification-bundle-score.test.ts`

## Implementation

- Introduce a typed `PublicContractBundle` with explicit provenance:
  - `contractId`
  - `kind`
  - `strength`
  - `provenance`
  - `subjectFiles`
  - `subjectSymbols`
- Initial contract kinds:
  - `exact-output`
  - `api-surface`
  - `owner-must-touch`
  - `lifecycle-owner`
  - `state-reset-semantics`
  - `multi-site-family`
- Allowed sources:
  - public issue text
  - public tests already present in the repo
  - validated repro scripts
  - static witness bundle (`lsp_definition`, `find_references`, repo-map, closure evidence)
- Forbidden sources:
  - known-instance patch/file-path regex
  - issue-family regex tuned to recover a benchmark miss
  - hidden PASS_TO_PASS or other oracle labels in runtime code
- Feed the bundle into the clean selector as a contract-dominance layer:
  - contract satisfaction can beat minimality.
  - contract satisfaction can beat symptom-family preference.
  - unsatisfied contracts can demote a candidate even if the patch is small.

## Hellgate

- A candidate that violates a generic `api-surface` contract cannot beat a candidate that satisfies it on size
  alone.
- A candidate that fails `owner-must-touch` cannot win over a candidate that touches the required owner file
  when executable proof is otherwise tied.
- `declaredExpected` extraction becomes one contract input, not a standalone selector authority surface.
- No contract builder test may mention a benchmark instance id or known gold file path.

## Done

- Clean selector reasoning can name satisfied/violated public contracts in telemetry.
- Contract extraction is generic, typed, and provenance-carrying rather than RCA-family-specific.

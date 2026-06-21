# SCAFF-05 — Public contract bridge

## Goal

Convert authoritative static witnesses into required public contracts so the clean
selector can prefer complete structural fixes before minimality.

## Files

- `src/runner/batch/eval/public-contract-bundle.ts`
- `src/runner/batch/eval/public-contract-types.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `tests/unit/public-contract-bundle.test.ts`
- `tests/unit/selection-clean-mode.test.ts`
- `tests/unit/runner/closure-repair-driver-parity.test.ts`

## Implementation

- Add `buildStaticWitnessContracts(witnesses)`:
  - authoritative `override-family` -> required `multi-site-family`;
  - authoritative `producer-consumer` -> required `multi-site-family`;
  - authoritative `registration-callback` -> required `multi-site-family`;
  - authoritative `unique-symbol-definer` -> required `owner-must-touch`.
- Preserve existing public issue/output/API contracts.
- Feed static-witness contracts into both runner and app selection paths.
- Add telemetry for:
  - `requiredContractsTotal`;
  - `requiredContractsSatisfied`;
  - violated required contract ids;
  - provenance of each required contract.

## Hellgate

- Candidate A touches one file and Candidate B touches every file in an
  authoritative multi-site witness. With executable proof tied, Candidate B wins.
- Minimality cannot overtake required contract satisfaction.
- Advisory witness cannot create a required contract.
- Contract builders cannot mention benchmark instance ids or known gold file paths.

## Done

- `requiredContractsSatisfied=0` is no longer the default for structurally known
  co-change cases.
- Clean selection has a real contract dominance tier to act on.

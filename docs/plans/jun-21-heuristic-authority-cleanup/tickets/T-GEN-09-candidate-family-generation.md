# T-GEN-09 — candidate family generation

## Goal

Replace the current single ranked owner list with family-separated candidate generation so a small symptom patch
cannot consume the whole search space before the root/API/lifecycle owner is explored.

## Files

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/closure-session.ts`
- optional: `src/runner/batch/eval/candidate-families.ts`
- `tests/unit/selection-executor.test.ts`
- `tests/unit/runner/verify-select-driver-parity.test.ts`

## Implementation

- Introduce a typed `CandidateFamily` surface:
  - `root-owner`
  - `symptom-owner`
  - `api-owner`
  - `lifecycle-owner`
  - `test-adjacent-owner`
- Replace `ownerCandidates: string[]` as the only seed source with a `CandidateFamilyBundle`:
  - `familyId`
  - `ownerFiles`
  - `reason`
  - `seed`
  - `sourceEvidence`
- Guarantee coverage:
  - emit at least one candidate per non-empty family before generating a second candidate from the same family.
  - allow fallback to the old single-list behavior only when only one family exists.
- Preserve deterministic ordering:
  - same family ordering rules across runs.
  - stable original order as final tie-break.
- Emit selection telemetry:
  - `candidate.familyId`
  - `candidate.familyReason`
  - `winningFamilyId`

## Hellgate

- When both `symptom-owner` and `root-owner` families exist, the generator emits one from each before reusing a
  family.
- A small symptom patch cannot crowd out a root-owner candidate before generation completes.
- No-family / single-family cases degrade cleanly to legacy ordering.
- Family IDs are stable across repeated runs on the same input.

## Done

- Candidate generation is visibly family-separated in telemetry.
- Selector regressions can assert that a symptom-only family no longer monopolizes the search space.

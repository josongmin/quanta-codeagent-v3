# T-CF-11 — semantic counterfactual contracts

## Goal

Extend counterfactual from structural minimality repair into semantic "opposite side of the failed contract"
generation.

## Files

- `src/runner/batch/eval/counterfactual-risk.ts`
- `src/runner/batch/eval/counterfactual-seed.ts`
- `src/runner/batch/eval/counterfactual-contract.ts`
- optional: `src/runner/batch/eval/public-contract-bundle.ts`
- `tests/unit/selection-counterfactual.test.ts`
- `tests/unit/selection-executor.test.ts`

## Implementation

- Keep existing structural contracts:
  - `singleOwnerFile`
  - `noNewDefs`
  - `noNewFiles`
  - `noRuntimeExpansion`
  - `nonEmptyPatch`
- Add semantic counterfactual contract kinds derived from the failed public contract side:
  - `mustTouchOwnerFamily`
  - `mustImplementApiSurface`
  - `mustFixLifecycleOwner`
  - `mustPreserveResetSemantics`
  - `mustCoverContractFamily`
- Derive the counterfactual seed from:
  - failed public contracts
  - winning/losing candidate family contrast
  - structural patch-budget facts
- Keep authority narrow:
  - semantic contracts bind only the counterfactual candidate spawned from them.
  - they do not become a global rejector for every candidate.
- Emit telemetry:
  - `counterfactual.contractKinds`
  - `counterfactual.targetFamily`
  - `counterfactual.violatedKinds`

## Hellgate

- When candidate 0 is a symptom-owner patch that misses a lifecycle-owner contract, counterfactual generation
  targets the lifecycle family rather than just demanding a smaller patch.
- A structurally smaller patch that still violates the semantic counterfactual contract remains dominated.
- Non-counterfactual candidates are not globally rejected by counterfactual contract logic.
- Telemetry distinguishes structural vs semantic contract violations.

## Done

- Counterfactual explores the opposite side of the failed contract, not merely a structurally narrower edit.
- Selector telemetry makes counterfactual intent and failure mode inspectable.

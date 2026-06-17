# T-6: PatchHygiene core split + verify linkage

**Priority:** P0 · **Size:** M · **Deps:** [T-3](T-3-closure-bundle-ssot.md) · **Posture:** OFF (`patch-hygiene`)

## Deliverable

Promote `PatchHygieneReport` into the closure core boundary and reuse it as an exact diff-fact input to gate decisions.

Version 1 behavior:

- hard-fail only exact stray-added-file violations
- `filesOutsideOwner` and `patchFileCount` become `GateSignals.stakes` inputs
- semantic "too wide" judgement remains telemetry only

This ticket also completes the split:

- core: deterministic diff facts
- bench: report emission, observe plumbing

## Touch files

- new `src/agent/closure/patch-hygiene.ts`
- `src/runner/batch/eval/patch-hygiene.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/eval/closure-diagnostics.ts`
- `tests/unit/patch-hygiene.test.ts`
- `tests/integration/bench-patch-hygiene.test.ts`

## Acceptance criteria

- [ ] `reproduce_issue.py` remains explicitly allowed.
- [ ] `.Z` / `.br` / junk artifact additions are blocked deterministically.
- [ ] `patchFileCount` and `filesOutsideOwner` are fed into gate stakes without LLM judgement.
- [ ] Owner-outside and width remain telemetry-first unless an exact deny rule fires.
- [ ] Existing report serialization remains stable when OFF.

## Hellgates

- `bun test tests/unit/patch-hygiene.test.ts`
- `bun test tests/integration/bench-patch-hygiene.test.ts`

Red cases this ticket must pin:

- stray added file not detected because hygiene stayed report-only
- semantic-width heuristic turns into a deny
- core/bench split regresses existing patch-hygiene outputs

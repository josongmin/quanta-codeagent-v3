# T-2: PrimaryRailStep promotion

**Priority:** P0 · **Size:** M · **Deps:** [T-1](T-1-evaluate-success-predicate.md) · **Posture:** OFF (`primary-rail`)

## Deliverable

Replace the string-only `primaryRailCmd` seam with a typed `PrimaryRailStep`.

```ts
type PrimaryRailStep = {
  cmd: string
  authority: "execution" | "structure" | "exact-diff"
  successPredicate: SuccessPredicate
}
```

The repair loop and validator should receive the selected step, not just the command string.

This ticket is shape promotion, not yet policy expansion:

- driver selects the step from `VerificationPlan.primaryRail`
- validator receives the step
- legacy behavior remains when no step is supplied

## Touch files

- `src/runner/batch/eval/repair/types.ts`
- `src/runner/batch/eval/repair/index.ts`
- `src/runner/batch/eval/repair/validator.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/types.ts`
- `tests/unit/repair-primary-rail-hellgate.test.ts`
- new `tests/unit/primary-rail-step-shape.test.ts`

## Acceptance criteria

- [ ] `RunRepairRoundsArgs` accepts `primaryRailStep`, not `primaryRailCmd`.
- [ ] Drivers thread the selected `VerificationPlan.primaryRail` step end to end.
- [ ] Unset step => byte-identical legacy agent-command gate.
- [ ] Validator output includes step-level provenance for later repair seeding.
- [ ] Existing primary-rail false-green protection still holds after shape promotion.

## Hellgates

- `bun test tests/unit/repair-primary-rail-hellgate.test.ts`
- `bun test tests/unit/primary-rail-step-shape.test.ts`

Red cases this ticket must pin:

- driver drops predicate/authority when threading the step
- repair loop silently reconstructs a string command and loses type info
- unset step path changes baseline behavior

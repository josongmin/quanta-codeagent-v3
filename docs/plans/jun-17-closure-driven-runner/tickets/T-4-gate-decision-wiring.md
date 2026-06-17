# T-4: GateDecision runtime wiring

**Priority:** P0 · **Size:** L · **Deps:** [T-1](T-1-evaluate-success-predicate.md), [T-2](T-2-primary-rail-step.md), [T-3](T-3-closure-bundle-ssot.md) · **Posture:** OFF (`primary-rail`)

## Deliverable

Wire `decideGate` into the bench runtime so the runner can actually choose between:

- `commit-now`
- `verify`

using structural signals instead of prompt instinct.

Phase 1 safety rules:

- only execution-grounded predicates may hard-block once measured safe
- exact-string / symbolic issue-derived predicates remain advisory
- low-signal or unevaluable cases degrade to legacy behavior, not false-RED
- gate decisions are derived from the `ClosureBundle`, not recomputed ad hoc

This ticket turns the existing pure policy into real control flow.

## Touch files

- `src/agent/gate-decision.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/eval/repair/index.ts`
- `src/runner/batch/eval/closure-diagnostics.ts`
- new `tests/integration/bench-gate-decision.test.ts`
- new `tests/unit/gate-decision-runtime-wiring.test.ts`

## Acceptance criteria

- [ ] High-confidence low-stakes cases may commit-fast without entering a useless verify loop.
- [ ] High-stakes / ambiguous cases enter verify-first using external signals only.
- [ ] Non-primary green never clears the primary rail.
- [ ] Advisory exact-string mismatch may pressure repair seeding but cannot hard-block finish in Phase 1.
- [ ] Gate-enter / gate-bypass metrics populate from actual runtime choices.

## Hellgates

- `bun test tests/unit/gate-decision-runtime-wiring.test.ts`
- `bun test tests/integration/bench-gate-decision.test.ts`

Red cases this ticket must pin:

- `decideGate` exists but is never consulted by the driver
- low-signal string mismatch blocks a correct patch
- verify loop still clears on a non-primary green

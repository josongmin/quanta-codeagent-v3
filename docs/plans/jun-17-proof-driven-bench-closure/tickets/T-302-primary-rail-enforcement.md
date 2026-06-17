# T-302: primary-rail enforcement + gate decision + repair admission

**Priority:** P0 · **Size:** L · **Deps:** [T-301](T-301-verification-plan.md) · **Posture:** OFF (`primary-rail` knob / `QUANTA_BENCH_PRIMARY_RAIL`)

## Deliverable

Upgrade bench closeout / repair semantics so they respect the selected `primaryRail`, not arbitrary verify noise:

- `GateDecision` chooses `commit-now` or `verify`, using structural signals rather than free-form model preference
- verify sources are limited to external evidence: `primaryRail`, structure resolution, and exact patch hygiene facts
- `mustPass` is satisfied only by the selected primary rail
- `repair` is allowed only when a primary rail exists and is red
- green external signal stops the loop immediately
- missing primary rail => no repair round

This is the ticket that keeps `repair` from over-correcting on the wrong command.

## Touch files

- `src/runner/batch/eval/repair/types.ts`
- `src/runner/batch/eval/repair/validator.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/agent/verify-guard.ts`
- `src/agent/stream-callbacks.ts`
- `src/agent/session-resources.ts`
- `src/config/knob-inventory.ts`
- `tests/integration/bench-repair.test.ts`
- `tests/unit/verify-guard-must-pass-hellgate.test.ts`

## Acceptance criteria

- [ ] Passing a non-primary verify command does not clear the primary-rail gate.
- [ ] Same-model self-critique or an unexecuted "I think it is fixed" verdict does not clear any gate.
- [ ] `GateDecision` uses structural signals (`stakes`, `uncertainty`, `signal availability`, `empty-patch / budget pressure`) rather than a free-form verify instinct.
- [ ] `repair` does not start when no primary rail was selected.
- [ ] Additional verify / repair rounds are hard-capped by repair budget; v1 stops after green or after the default two extra repair rounds beyond round 0.
- [ ] `bench-in-loop-exec:off` keeps the existing single-pass / no-verify posture.
- [ ] Regression fixture covers the `django__django-10914` class: PASS baseline must not turn into FAIL because of a non-primary repair seed.

## Proof rail

- `bun test tests/integration/bench-repair.test.ts`
- `bun test tests/unit/verify-guard-must-pass-hellgate.test.ts`

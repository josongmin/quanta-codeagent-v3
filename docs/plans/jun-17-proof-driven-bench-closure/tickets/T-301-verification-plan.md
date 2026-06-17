# T-301: `VerificationPlan` builder

**Priority:** P1 · **Size:** L · **Deps:** [T-101](T-101-closure-diagnostic-rail.md), [T-202](T-202-owner-admission-first-edit.md) · **Posture:** OFF (`verification-plan` knob / `QUANTA_BENCH_VERIFICATION_PLAN`)

## Deliverable

Build a typed `VerificationPlan` artifact with:

- `primaryRail`
- `required` steps
- `optional` steps
- `baseValidatedRed` for any synthesized repro promoted to a required rail

Selection authority is public evidence only:

- selected repro script when present
- owner-near test
- touched-module smoke

No hidden labels, no gold patch hints, and no same-model self-critique counted as required verification.

## Touch files

- new `src/agent/verification-plan/types.ts`
- new `src/agent/verification-plan/build.ts`
- new `src/runner/batch/eval/verification-plan.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/types.ts`
- `src/config/knob-inventory.ts`
- new `tests/unit/verification-plan.test.ts`
- new `tests/unit/bench-verification-plan-wiring.test.ts`

## Acceptance criteria

- [ ] If a repro script is synthesized or installed, it becomes `primaryRail` only after it fails on the unpatched base (`red-on-injection`).
- [ ] If no repro exists, planner selects one primary required step from public evidence only.
- [ ] First version hard-caps required steps at 3.
- [ ] Required verification sources are execution or structural evidence only; any self-critique remains advisory.
- [ ] Planner output is serialisable onto bench reports / artifacts.
- [ ] Planner OFF => byte-identical prompt path.

## Proof rail

- `bun test tests/unit/verification-plan.test.ts`
- `bun test tests/unit/bench-verification-plan-wiring.test.ts`

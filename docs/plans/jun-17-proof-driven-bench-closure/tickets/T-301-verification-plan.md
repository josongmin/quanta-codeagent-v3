# T-301: `VerificationPlan` builder

**Priority:** P1 · **Size:** L · **Deps:** [T-101](T-101-closure-diagnostic-rail.md), [T-202](T-202-owner-admission-first-edit.md) · **Posture:** OFF (`verification-plan` knob / `QUANTA_BENCH_VERIFICATION_PLAN`)

## Deliverable

Build a typed `VerificationPlan` artifact with:

- `primaryRail`
- `required` steps
- `optional` steps
- `baseValidatedRed` for any synthesized repro promoted to a required rail

Each `required` step in v1 must be a proof contract, not just a command:

- `kind`
- `authority` (`execution` | `structure` | `exact-diff`)
- `target`
- `successPredicate`
- optional `failurePredicate`

Initial closed `successPredicate` shapes:

- `stdout_exact_empty`
- `stdout_contains`
- `stderr_absent`
- `symbolic_repr_equals`
- `ast_or_dom_shape`
- `latex_or_string_exact`
- `test_exit_zero`
- `selected_test_passes`

Selection authority is public evidence only:

- selected repro script when present
- owner-near test
- touched-module smoke
- **issue-declared expected output (public)** — when the problem statement exposes a
  concrete expected/observed output, encode it as the `successPredicate` of a required
  step (e.g. `latex_or_string_exact`, `symbolic_repr_equals`, `stdout_exact_empty`).
  This is the gap-B (spec-fidelity) rail: the issue text is public input, never oracle.
  Pairs with T-601 `spec_literal_available_but_not_followed` — T-601 detects the signal,
  T-301 turns it into the proof contract.

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
- [ ] Every required step has a typed `successPredicate`; "run command and inspect loosely" is not a valid contract.
- [ ] Planner can represent exact output/fallback/shape contracts when public evidence exposes them.

## Proof rail

- `bun test tests/unit/verification-plan.test.ts`
- `bun test tests/unit/bench-verification-plan-wiring.test.ts`

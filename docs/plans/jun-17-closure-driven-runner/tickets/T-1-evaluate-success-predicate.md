# T-1: evaluate-success-predicate core + observe-only validator

**Priority:** P0 · **Size:** L · **Deps:** — · **Posture:** observe-only (never blocks finish in v1)

## Deliverable

Add a pure core evaluator that judges a `SuccessPredicate` against an observed command result, and thread it into the bench validator in observe-only mode first.

Split the seam cleanly:

- core: `given predicate + observed output -> verdict`
- adapter: `exec command -> observed output`

Phase 1 rules:

- hard-gate only execution-grounded predicates once measured safe
- exact-string / symbolic issue-derived predicates stay advisory
- unevaluable / low-confidence cases fail OPEN and degrade to the legacy exit-code result

Initial predicate coverage:

- `test_exit_zero`
- `selected_test_passes`
- `stdout_contains`
- `stdout_exact_empty`
- `latex_or_string_exact` (advisory in v1)
- `symbolic_repr_equals` (advisory in v1)

## Touch files

- new `src/agent/closure/evaluate-success-predicate.ts`
- new `src/agent/closure/types.ts`
- `src/runner/batch/eval/repair/validator.ts`
- `src/runner/batch/eval/repair/types.ts`
- `src/agent/verification-plan/types.ts`
- new `tests/unit/closure/evaluate-success-predicate.test.ts`
- new `tests/integration/bench-validator-observe-only.test.ts`

## Acceptance criteria

- [ ] Evaluator is pure and deterministic.
- [ ] Validator captures observed `code/stdout/stderr` and computes predicate verdicts without changing finish behavior yet.
- [ ] Unevaluable predicate => fail-open degrade, not hard fail.
- [ ] `latex_or_string_exact` and `symbolic_repr_equals` are advisory only in v1.
- [ ] Exit code `0` with predicate mismatch is recorded distinctly as `predicateMatched:false`.
- [ ] Knob/OFF path remains byte-identical.

## Hellgates

- `bun test tests/unit/closure/evaluate-success-predicate.test.ts`
- `bun test tests/integration/bench-validator-observe-only.test.ts`

Red cases this ticket must pin:

- delete fail-open degrade => exact-string false-RED
- treat exact-string as blocking in v1 => advisory guarantee broken
- keep validator as exit-code-only => predicate observations never materialize

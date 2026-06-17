# Closure-Driven Runner — Ticket Backlog (SSOT)

7 tickets extracted from [../README.md](../README.md). Status: `OPEN` unless noted.
Sizes: S (<= 1/2d), M (~1d), L (multi-day). Phase 1 = bench-first validation of the closure engine.
Phase 2 = mode-profile generalization (`autonomous` / `collaborative`) after Phase 1 metrics clear.

## Execution order

**Wave 0:** T-1 -> T-2 -> T-3  
**Wave 1:** T-4 || T-6  
**Wave 2:** T-5 -> T-7  
**Wave 3:** conditional `spec-fidelity-steer` A/B on top of the validated engine

## House constraints

- No runtime hidden-oracle reads: `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, official grader reports are forbidden routing inputs.
- Core code does NOT imply core activation. New closure behavior stays default-OFF / observe-first until Phase 1 metrics clear.
- `issueDeclaredExpected` exact-string / symbolic predicates are advisory until proven safe. Hard-gate only execution-grounded predicates in Phase 1.
- Predicate evaluator must fail OPEN on unevaluable / low-confidence cases. False-RED is worse than today's false-green.
- `ClosureBundle` is the one SSOT artifact. Prompt, gate, repair, and diagnostics must consume the same bundle snapshot.
- Bench drivers remain thin adapters. Pure decision logic belongs under `src/agent/closure/*`.
- Prompt growth is not the lever. Validator + gate carry the enforcement.
- `agentless-v1` and non-opted-in surfaces must remain byte-identical.

## What already exists

Most closure-engine fragments are already real code, not proposals:

- `src/agent/gate-decision.ts`
- `src/agent/primary-rail/`
- `src/agent/fault-evidence/`
- `src/agent/owner-admission/`
- `src/agent/verification-plan/`
- `src/runner/batch/eval/repair/validator.ts`
- `src/runner/batch/eval/patch-hygiene.ts`

So Phase 1 is not "build from scratch". The actual work is:

1. bind them into a `ClosureBundle` SSOT,
2. add a predicate-aware evaluator,
3. keep validator observe-only first,
4. measure,
5. only then turn on behavior-changing gates.

## Ticket table

| ID | Title | What closes | Pri | Size | Deps | Posture |
|---|---|---|---|---|---|---|
| T-1 | evaluate-success-predicate core + observe-only validator | exit-code-only validation, false-green blind spot | P0 | L | — | observe-only |
| T-2 | PrimaryRailStep promotion | `primaryRailCmd` string-only seam | P0 | M | T-1 | OFF (`primary-rail`) |
| T-3 | ClosureBundle SSOT + diagnostics wiring | duplicated closure facts, missing leading indicators | P0 | L | T-1, T-2 | telemetry-first |
| T-4 | GateDecision runtime wiring | no real commit-fast / verify-first control | P0 | L | T-1, T-2, T-3 | OFF (`primary-rail`) |
| T-5 | OwnerAdmission prompt/gate linkage | owner facts exist but do not affect actions | P1 | M | T-3, T-4 | OFF (`fault-evidence`) |
| T-6 | PatchHygiene core split + verify linkage | exact diff facts not reused by gate | P0 | M | T-3 | OFF (`patch-hygiene`) |
| T-7 | explicit multi-owner escalation | widening still ad hoc / heuristic | P1 | M | T-4, T-5, T-6 | OFF (`repair-escalation`) |

## Success criteria before Phase 2

- `owner_recall@1` up
- `first_edit_owner_match` up
- `primary_rail_present_rate` up
- `required_verification_coverage` up
- `primary_false_green_rate` down
- `primary_false_RED_rate` near zero
- `no_patch_exhausted_rate` down

Only after these move do we extract `src/agent/runner.ts`, `src/agent/mode-profile.ts`, and `src/apps/chat/*`.

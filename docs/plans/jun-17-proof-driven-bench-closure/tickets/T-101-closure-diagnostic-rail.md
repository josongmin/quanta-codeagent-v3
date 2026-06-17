# T-101: closure diagnostic rail + report sidecar

**Priority:** P0 · **Size:** M · **Deps:** none · **Posture:** offline only

## Deliverable

Add an offline diagnostic sidecar for bench runs that measures closure quality before score:

- owner recall (`@1`, `@3`)
- `first_edit_owner_match`
- `required_verification_coverage`
- `primary_rail_present_rate`
- `primary_false_green_rate`
- `gate_enter_rate`
- `gate_bypass_rate`
- `verify_rounds_per_run`
- `synth_repro_base_red_rate`
- `stray_file_rate`
- `no_patch_exhausted_rate`
- `sibling_coverage_expected_rate`
- `sibling_coverage_miss_rate`
- `spec_literal_signal_rate`
- `spec_literal_follow_rate`
- `success_predicate_present_rate`
- `primary_success_predicate_mismatch_rate`

The oracle input is evaluation-only and MUST NOT be loaded by runtime routing or prompt rendering.

## Touch files

- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- `src/runner/batch/core.ts`
- `src/apps/bench/eval/driver.ts`
- new `src/runner/batch/eval/closure-diagnostics.ts`
- new `tests/unit/closure-diagnostics.test.ts`

## Acceptance criteria

- [ ] Diagnostic oracle format is separate from runtime inputs and never threaded into `driver.ts` routing.
- [ ] `report.json` gains a stable sidecar section or a sibling artifact without changing the no-knob runtime path.
- [ ] Empty diagnostic input degrades cleanly to "metrics unavailable", not crash.
- [ ] Sidecar can classify `#9296`-style empty-patch runs separately from model-miss runs.
- [ ] `first_edit_owner_match` is derived from the first observed mutating edit event, not guessed from the final diff alone.
- [ ] Gate-bypass / gate-enter events are reported separately so under-verify and over-verify regressions are distinguishable.
- [ ] Sidecar can distinguish "sibling coverage was expected" from "sibling coverage was actually touched".
- [ ] Sidecar can report when an exact spec literal signal existed but the chosen verification contract did not reflect it.

## Proof rail

- `bun test tests/unit/closure-diagnostics.test.ts`
- `bun test tests/unit/bench-report-knobs.test.ts`

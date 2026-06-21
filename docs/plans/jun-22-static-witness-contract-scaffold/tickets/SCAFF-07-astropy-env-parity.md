# SCAFF-07 — Astropy env parity

## Goal

Fix astropy repro/candidate verification environment parity so executable rails can
run instead of failing before candidate evaluation.

## Files

- `src/runner/batch/corpus/project-env.ts`
- `src/runner/batch/eval/selection-repro-consensus.ts`
- `src/runner/batch/eval/selection-smoke.ts`
- `src/runner/batch/eval/repro-runner.ts` if present
- `tests/unit/repro-run-argv.test.ts`
- `tests/unit/project-env.test.ts`

## Problem

The clean report for `astropy__astropy-13033` shows all repro samples failed with
`No module named 'setuptools.dep_util'`. This is not a model failure and not a
selector failure. The executable scaffold cannot produce authority while project
env setup is inconsistent across repro, candidate, and grading-style execution.

## Implementation

- Audit every selection/repro command path and ensure it uses
  `buildProjectEnvUvRunArgv()`.
- Ensure astropy adds:
  - `setuptools<60`;
  - `extension_helpers`;
  - `--no-build-isolation`.
- Verify the flags apply to the subprocess that executes extracted public MWEs,
  not only to normal agent commands.
- Surface env-prep failure as `env_prep_failed` or `repro_execution_failed`,
  never as candidate unresolved evidence.

## Hellgate

- Unit test argv for astropy includes `--no-project`, `--with setuptools<60`,
  `--with extension_helpers`, `--with-editable .`, and `--no-build-isolation`.
- Repro consensus path and smoke path use the same env builder.
- Missing build dependency is reported before selection as infra, not as model miss.

## Done

- Astropy public MWE execution can reach repo import/test behavior.
- Repro/env failures are isolated from selector quality claims.

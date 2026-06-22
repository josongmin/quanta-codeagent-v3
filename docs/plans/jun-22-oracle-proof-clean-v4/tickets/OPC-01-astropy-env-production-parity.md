# OPC-01 - Astropy Env Production Parity

## Goal

Make astropy public MWE and repro execution reach repo behavior instead of
failing during editable install.

## Problem

The latest 3-case v4 run failed `astropy__astropy-13033` before candidate
evaluation:

`No module named 'extension_helpers'`

`src/runner/batch/corpus/project-env.ts` already contains astropy-specific env
authority:

- `setuptools<60`
- `extension_helpers`
- `--no-build-isolation`

The failure means at least one production repro/MWE path is not using the shared
project env builder, or the report is collapsing env setup failure into
candidate-red selection.

## Implementation

Audit all public proof execution paths and force them through the same builder:

- `buildProjectEnvUvRunArgv(repo, version, extraWith)`
- repro candidate execution
- public MWE smoke execution
- selection repro consensus execution
- any app-side bench driver wrapper that shells into a repo

Add explicit proof failure states:

- `env_prep_failed`
- `execution_failed`
- `base_not_red`
- `candidate_red`
- `patched_green`

Only `candidate_red` after successful base-red setup may veto candidate
correctness. `env_prep_failed` and `execution_failed` are infra/proof failures.

## Files

- `src/runner/batch/corpus/project-env.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/selection-smoke.ts`
- `src/runner/batch/eval/selection-repro-consensus.ts`
- `src/apps/bench/eval/driver.ts`
- `tests/unit/repro-run-argv.test.ts`
- `tests/unit/bench-repro-test-wiring.test.ts`

## Acceptance

- Unit tests capture production argv for an astropy SWE-bench instance.
- Captured argv includes `uv run --no-project`, `--with setuptools<60`, `--with extension_helpers`, `--with-editable .`, and `--no-build-isolation`.
- Public MWE and repro consensus paths share the same argv builder.
- Astropy env failure is reported before candidate selection as `env_prep_failed` or `execution_failed`.

## Hellgate

Do not special-case `astropy__astropy-13033`. The only permitted specialization
is repo-level environment parity for `astropy/astropy`, already represented in
the project env authority.


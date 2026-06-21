# SCAFF-06 — Executable public MWE rail

## Goal

Turn public issue reproductions into executable proof receipts where possible,
without using hidden tests or benchmark-specific answer keys.

## Files

- `src/agent/verification-plan/extract-issue-repro.ts`
- `src/runner/batch/eval/selection-smoke.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `tests/unit/repro-run-argv.test.ts`
- `tests/unit/selection-clean-mode.test.ts`
- `tests/unit/issue-repro-extraction.test.ts`

## Implementation

- Keep issue MWE extraction as seed generation only until base-red is proven.
- Add explicit proof states:
  - `not_found`
  - `base_not_red`
  - `base_red`
  - `patched_green`
  - `execution_failed`
- Clean hard authority requires:
  - base execution reproduced the public failure;
  - candidate execution passed the same MWE;
  - command ran in the same project env as candidate verification.
- If base-red cannot be established, the MWE may guide generation but cannot veto
  selection.

## Target public MWEs

- subprocess/env boundary behavior for backend shell command execution.
- timezone conversion behavior across backend operations and sqlite UDF registration.
- astropy TimeSeries required-column removal behavior once env parity is fixed.

## Hellgate

- Extracted code fence alone cannot hard-reject a candidate.
- A base-green MWE cannot become clean veto authority.
- `execution_failed` is an infra/repro failure, not candidate correctness.
- `patched_green` telemetry must include the command, env prefix, and exit status.

## Done

- Public executable evidence can dominate contracts when valid.
- Failed repro setup is reported separately from model/scaffold correctness.

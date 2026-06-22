# OPC-04 - Public Regression Discovery

## Goal

Use public tests as executable safety evidence selected by structural coverage,
and admit only the subset that encodes issue-positive behavior. Do not use hidden
SWE-bench labels.

## Problem

Some cases do not expose a reliable issue MWE. v4 needs a clean public-test
surface, but a generic base-green/candidate-green test only proves no regression.
It does not prove the issue was fixed.

## Implementation

Build a public regression discovery port:

- Determine touched symbols from patch AST and LSP/static references.
- Find repo tests that import, call, subclass, or assert around those symbols.
- Run selected tests on the base repo first.
- Only base-green tests can become regression authority.
- Run the same selected tests on the patched candidate.
- Candidate is safety-positive if selected base-green tests remain green.
- Candidate is fix-positive only when the selected public test encodes an
  issue-specific behavioral assertion that fails or violates the issue condition
  on base and passes on the candidate.

Use the port for proof authority:

- `safety_green_public_regression` if selected public tests are base-green and candidate-green.
- `issue_positive_public_regression` only if the public test exercises the issue
  condition and proves base failure or equivalent baseline violation, then
  candidate success.
- `base_not_green` means no authority from that test.
- test discovery failure means no authority, not candidate correctness failure.

Target structural coverage surfaces:

- `django.db.backends.*.client.runshell` and `settings_to_cmd_args_env` for shell/env command behavior.
- `django.db.backends.*.operations` and sqlite converter registration for datetime behavior.
- `astropy.timeseries.core.TimeSeries` and table column removal behavior after env parity is fixed.

## Files

- `src/runner/batch/eval/impacted-test-discovery.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/static-witness-adapter.ts`
- `tests/unit/impacted-test-discovery.test.ts`
- `tests/unit/selection-executor.test.ts`

## Acceptance

- Discovery uses AST/LSP/static references, not instance IDs or known failing test names.
- Base-green preflight is required before a discovered public test can become proof authority.
- Generic public regression keep-green cannot admit a candidate in v4 when MWE
  proof is absent.
- Issue-positive public regression proof can admit a candidate in v4 when MWE
  proof is absent.
- Discovery telemetry records selected tests, base result, candidate result, and structural reason.

## Hellgate

Do not import hidden SWE-bench `FAIL_TO_PASS`/`PASS_TO_PASS` labels into this
path. They are only offline diagnostics.

Do not treat keep-green safety tests as proof that the bug was fixed.

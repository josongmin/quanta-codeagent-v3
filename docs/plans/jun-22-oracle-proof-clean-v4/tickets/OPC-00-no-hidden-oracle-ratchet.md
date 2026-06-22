# OPC-00 - No Hidden Oracle Ratchet

## Goal

Make clean/v4 runtime authority auditable: no hidden benchmark labels, no
instance-specific gates, no answer-key regexes.

## Problem

The project has had clean-score gains that were later shown to depend on
targeted or contaminated authority. Before adding more proof logic, the clean
runtime needs a ratchet that prevents those mechanisms from becoming submittable
authority again.

## Implementation

Add a runtime and test-level allowlist for clean presets:

- Clean selector code may not read `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, gold patch data, official harness verdicts, or contaminated-case IDs.
- Clean selector code may not enable `rca-target-gates`, `declaredExpected`, or case-family keyword gates.
- Static witness modules may emit telemetry and repair seeds, but may not set candidate admissibility alone.
- A new unit test should fail if `agentless-v4-proof-clean` enables any forbidden knob.
- A source-level ratchet should scan clean authority modules for forbidden strings and known contaminated case IDs.

## Files

- `src/runner/knobs/presets.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `tests/unit/clean-preset-research-knob-allowlist-ratchet.test.ts`
- `tests/unit/selection-executor.test.ts`

## Acceptance

- `agentless-v4-proof-clean` cannot enable targeted gates.
- Contract/static witness telemetry cannot produce `admissible=true` without an executable proof.
- Tests fail if hidden SWE-bench label names are introduced into clean authority paths.

## Hellgate

No benchmark instance ID, file-path regex, issue-keyword regex, or official hidden test label may decide candidate admission in this ticket.


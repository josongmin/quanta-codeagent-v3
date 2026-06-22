# OPC-03 - v4 Proof-Required Selector

## Goal

Make `agentless-v4-proof-clean` fail closed when no executable proof exists,
while preserving v3 clean as the A/B control.

## Problem

The current v4 name implies proof-clean selection, but the latest run still
submitted proof-missing Django candidates. That makes benchmark failures hard to
interpret because the report cannot distinguish model miss, proof miss, and
infra miss.

## Implementation

Add a preset-controlled proof-required mode:

- `verify-select-proof-required=true`
- default off outside v4
- enabled by `agentless-v4-proof-clean`
- disabled in `agentless-v3-thin-strict-closure-select-clean`

Selector behavior:

- Candidate with executable proof: rank and submit.
- Candidate with contract-only evidence: bounded repair seed, no submit.
- Candidate with infra proof failure: fail with infra/proof status, no candidate correctness claim.
- No candidate with proof after bounded repair: return empty patch with `proofRequiredMissing`, not generic unresolved.

Repair behavior:

- At most one bounded repair round in v4 proof-clean unless a later ticket adds measured evidence.
- Repair prompt receives typed proof failure facts only.
- Repair prompt does not receive hidden tests or gold expectations.

## Files

- `src/runner/knobs/presets.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/knobs-bench.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `tests/unit/selection-executor.test.ts`

## Acceptance

- `agentless-v4-proof-clean` exposes proof-required mode in report knobs.
- v3 clean behavior does not change when v4 is introduced.
- Contract-only candidates return `hard:proofRequiredMissing=true`.
- Empty patch from proof-required mode is classified as proof miss, not silent selector failure.

## Hellgate

Do not make proof-required behavior conditional on the three failed instance IDs.


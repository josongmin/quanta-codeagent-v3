# OPC-02 - Proof Authority Lattice

## Goal

Define one selector-side authority lattice so every candidate has an explicit
reason for being submittable or blocked.

## Problem

`django__django-11138` and `django__django-14315` selected candidates with
`voterQuorum=0` and no executable proof. They were admitted because static
contracts and owner coverage were still acting like enough authority.

That is not proof-clean behavior.

## Implementation

Introduce a typed `ProofState` for candidate selection:

- `missing`
- `env_failed`
- `base_not_red`
- `base_green_guard`
- `patched_green_public_mwe`
- `issue_positive_public_regression`
- `safety_green_public_regression`
- `patched_green_repro_consensus`

Introduce a typed `ProofAuthority` decision:

- `admit`
- `repair_only`
- `reject`
- `infra`

Admission rule:

- `admit` requires at least one executed public proof source.
- A proof source is fix-positive only if it observed the public issue failing on
  base and passing on the candidate, or an equivalent issue-specific behavioral
  assertion.
- Generic public regression keep-green is safety evidence. It may block a
  regression, rank candidates, or combine with fix-positive proof, but it may not
  admit a candidate by itself.
- Static contracts may increase score only after `admit` is already possible.
- Static contracts may send a candidate to bounded repair when proof is missing.
- Static contracts must never convert `missing` to `admit`.

## Files

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- `tests/unit/selection-executor.test.ts`
- `tests/unit/selection-structural-repair-driver.test.ts`

## Acceptance

- A multi-file candidate with `requiredContractsSatisfied=7`, `voterQuorum=0`, and no public proof is not submittable.
- The same candidate becomes submittable only after `patched_green_public_mwe`,
  `issue_positive_public_regression`, or `patched_green_repro_consensus`.
- A candidate with only `safety_green_public_regression` is not submittable.
- `contractOnlySubmitted` is impossible in v4 proof-clean reports.
- The selector reports `repair_only` instead of silently ranking contract-only candidates.

## Hellgate

No weighted score, owner coverage fraction, or contract count may override
`ProofState=missing`.

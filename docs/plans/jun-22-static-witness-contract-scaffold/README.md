# Static witness -> clean contract scaffold plan

Related:

- [Heuristic authority cleanup](../jun-21-heuristic-authority-cleanup/README.md)
- [Contaminated / ambiguous cases](../jun-21-heuristic-authority-cleanup/contaminated-cases.md)

## Purpose

Replace benchmark-shaped heuristic authority with a general scaffold:

```text
static engine = typed relation witness
candidate families = force search-space coverage
public contracts = express required co-change / API obligations
executable proofs = admit, veto, or stop
minimality = final tie-break only
```

This is the replacement layer after the Jun 21 cleanup. The selector can already
rank contracts before minimality; the current failure is that the scaffold often
does not produce required clean contracts.

## Current evidence

`agentless-v3-thin-strict-closure-select-clean` still fails the three RCA cases:

- `django__django-14315`: owner files include `django/db/backends/postgresql/client.py`
  and `django/db/backends/base/client.py`, but the winning patch only touches
  `base/client.py`. The report shows `requiredContractsSatisfied=0`, so the
  clean selector has no hard multi-site obligation to prefer a complete co-change.
- `django__django-11138`: a broader backend-family candidate exists, but the
  winning patch touches only the sqlite path. Again `requiredContractsSatisfied=0`,
  so minimality can still win.
- `astropy__astropy-13033`: repro generation/execution fails before useful
  executable selection because the astropy env cannot import `setuptools.dep_util`.

Current code seams:

- `src/agent/verification-bundle/select-lexicographic.ts` already makes contracts
  outrank minimality.
- `src/runner/batch/eval/public-contract-bundle.ts` can express required
  `multi-site-family` contracts.
- `src/runner/batch/eval/candidate-families.ts` currently only builds multi-site
  families from shared symbol witnesses.
- `src/agent/fault-evidence/build.ts` still treats bare `owner-resolve` as advisory
  because unique/structural provenance is not tracked.
- `src/runner/batch/eval/patch-budget-admission.ts` already includes
  `ownerResolved` sibling files as owner files, so patch budget is not the first
  blocker when witness evidence is correct.

## Non-goals

- No instance-id special cases.
- No known patch, gold patch, `FAIL_TO_PASS`, `PASS_TO_PASS`, or hidden grader
  data in runtime authority.
- No Django backend path regex as a solve mechanism.
- No issue-keyword target-family steer.
- No weighted magic-score tuning to recover clean solves.
- No early accept from static evidence without executed proof.

## Ticket order

1. [SCAFF-01 Static witness IR](./tickets/SCAFF-01-static-witness-ir.md)
2. [SCAFF-02 Static engine adapter](./tickets/SCAFF-02-static-engine-adapter.md)
3. [SCAFF-03 Owner evidence lattice](./tickets/SCAFF-03-owner-evidence-lattice.md)
4. [SCAFF-04 Candidate family expansion](./tickets/SCAFF-04-candidate-family-expansion.md)
5. [SCAFF-05 Public contract bridge](./tickets/SCAFF-05-public-contract-bridge.md)
6. [SCAFF-06 Executable public MWE rail](./tickets/SCAFF-06-executable-public-mwe-rail.md)
7. [SCAFF-07 Astropy env parity](./tickets/SCAFF-07-astropy-env-parity.md)
8. [SCAFF-08 Clean contamination ratchet](./tickets/SCAFF-08-clean-contamination-ratchet.md)

## Execution policy

- Build typed witness first, then contract bridge, then executable rails.
- Keep runner driver and app driver in parity for every new scaffold input.
- Every clean authority path must have a unit hellgate and a paired negative test.
- Every benchmark claim must name the exact preset, report path, and whether the
  solve is clean, contaminated, or attribution-unproven.

## Promotion criteria

The plan is complete only when all of these hold:

- clean presets expose no research-only authority knobs;
- static witness can generate the required co-change family for the Django cases
  without instance/gold/path-regex contamination;
- complete-family candidates beat incomplete single-site candidates when
  executable proof is tied;
- astropy repro/env setup runs far enough to make executable selection meaningful;
- the three target cases are rerun remotely under
  `agentless-v3-thin-strict-closure-select-clean`;
- unresolved cases produce telemetry splitting `witness`, `contract`,
  `candidate-generation`, `executable-proof`, and `grading` failure modes.

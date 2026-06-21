# T-MEASURE-08 — promotion policy and holdout audit

## Goal

Prevent future heuristic authority from entering clean presets without measured evidence.

## Files

- `docs/swebench-ec2-runbook.md`
- `docs/swebench-leaderboard.md`
- `docs/plans/jun-21-heuristic-authority-cleanup/README.md`
- optional: `src/runner/batch/eval/authority-telemetry.ts`
- optional: `tests/unit/authority-promotion-policy.test.ts`

## Implementation

Promotion stages:

1. `observe-only`: signal is recorded but cannot affect selection.
2. `shadow`: signal emits `wouldReject` or `wouldRank` beside actual clean decision.
3. `holdout A/B`: signal is evaluated on non-targeted holdout instances.
4. `false-reject audit`: every rejected candidate must have executable counter-evidence.
5. `clean promotion`: only after documented pass criteria.

Make the holdout machine-verifiable, not self-attested:

- Each tunable signal ships a checked-in `tuning-manifest` entry listing every
  instance id that informed its thresholds / regexes / weights (the design set).
- The stage-3 holdout set must be DISJOINT from that design set. A test computes
  the intersection and fails the promotion if it is non-empty.
- A signal with thresholds but no `tuning-manifest` entry cannot reach stage 3 —
  "holdout" is meaningless without a declared design set to exclude.
- The quorum `k` and any surviving numeric cutoff are tunable signals for this
  purpose and need a manifest entry too (ties back to T-AUTH-01).

Required metrics:

- raw resolved count.
- turns.
- patch bytes.
- multi-file rate.
- added-def rate.
- false-reject count.
- false-admit count where available.
- research contamination label.

Hard promotion blockers:

- issue ID or issue-family regex.
- file-path patch matching for known instances.
- magic threshold without holdout evidence.
- single-instance green used as general proof.
- hidden test or PASS_TO_PASS labels in engine code.

## Hellgate

- A new clean hard gate without promotion metadata fails tests or documentation check.
- A signal whose holdout set intersects its declared design set fails the
  promotion test (disjointness is computed, not asserted).
- A tunable signal with no `tuning-manifest` entry cannot be marked stage-3-passed.
- Research-contaminated runs cannot be reported as clean score.
- A/B report separates score delta from minimality/cost metrics.

## Done

- There is a written path from idea to clean authority.
- Research wins cannot silently become default benchmark claims.

# T-RESOLVE-14 — clean re-solve and leaderboard score correction

## Goal

Execute the clean re-solve campaign for every contaminated / unproven receipt in
`contaminated-cases.md`, and restate the published benchmark count so the reported
"clean score" stops including heuristic-authority wins. Without this ticket the
whole cleanup is policy-only: the presets get clean but the already-published
number stays contaminated.

T-MEASURE-08 is the FORWARD gate (no new heuristic enters clean). This ticket is
the BACKWARD correction (existing contaminated receipts leave clean).

## Files

- `docs/plans/jun-21-heuristic-authority-cleanup/contaminated-cases.md`
- `docs/swebench-leaderboard.md`
- `docs/swebench-leaderboard.yaml`
- `docs/swebench-ec2-runbook.md`
- optional: `src/runner/batch/eval/score-label.ts`
- optional: `tests/unit/score-label.test.ts`

## Score-label taxonomy

Two buckets are not enough. The plan currently collapses local-structural green
into "clean", but a run graded only by local pytest is not the same claim as one
graded by the official harness. Define three explicit labels and forbid
upgrading between them silently:

- `official_harness` — applied patch graded by the official SWE-bench harness
  (`FAIL_TO_PASS` + `PASS_TO_PASS` in the container). The only label reportable as
  leaderboard-grade resolved.
- `local_structural` — executed local witness/keep-green/repro green, but NOT the
  official harness. Legitimate scaffold-internal authority and a legitimate
  intermediate claim; never reported as `official_harness`.
- `research_contaminated` — any run touching a research knob/preset
  (`research/*`, `declaredExpected` authority, `repro-doubt`, discovered-regression
  magic score). Never reported as clean.

A receipt's label is the WEAKEST of its inputs (research-contaminated dominates;
local_structural never auto-promotes to official_harness without an actual harness
run). This is the honest-expression rule from the plan made into a typed enum.

## Implementation

- Re-solve every case in `contaminated-cases.md` on a clean preset
  (`T-PRESET-07` allowlisted, no research knob), graded by the official harness:
  - bucket 1 (contaminated solved, n=2): `django-11138`, `django-14315`.
  - bucket 2 (targeted heuristic present, n=1): `astropy-13033`.
  - bucket 3 (heuristic-bearing, attribution unproven, n=8): `django-13128`,
    `django-13417`, `pydata/xarray-3677`, `astropy-13579`, `django-16139`,
    `matplotlib-25122`, `mwaskom/seaborn-3069`, `matplotlib-20488`.
- Honor the existing `contaminated-cases.md` "Replay requirements" verbatim:
  - `selection-declared-expected.ts` not wired to clean authority.
  - `rca-target-gates` off, no `RCA_*_STEER` literal in the prompt path.
  - `declaredExpectedMatch=false` never used as an inadmissible reason.
- For each case, record the clean re-solve outcome with its `official_harness`
  label, and stamp the OLD receipt `research_contaminated` (do not delete it —
  keep it for audit, just relabel).
- Restate `docs/swebench-leaderboard.{md,yaml}`:
  - report the clean (`official_harness`) count as the headline number.
  - show the contaminated delta separately (how many wins left the clean count and
    why), so the correction is visible rather than a silent downward edit.
  - per `feedback-record-winning-config`, the restated entry carries the full
    config (clean preset name + every active knob + model).
- Do NOT merge old contaminated receipts and new clean receipts into one score
  bucket (the existing replay requirement).

## Promotion conditions per bucket

- bucket 1: clean re-solve PASS under official harness => counts clean. FAIL =>
  drops from clean count (it was a contaminated win).
- bucket 2 / bucket 3: a case counts clean only when either
  - clean (signal-off) replay PASSes under official harness, or
  - a selector-on/off counterfactual proves the same patch was submitted without
    the heuristic signal changing the outcome.
- Until one of those holds, the case stays out of the clean count (ambiguous, not
  silently clean).

## Hellgate

- The leaderboard headline count equals the number of `official_harness`-labelled
  clean receipts, computed from the receipts, not hand-edited.
- A `research_contaminated` or `local_structural` receipt cannot contribute to the
  `official_harness` count (typed label, enforced by test).
- `local_structural` cannot be rendered as official resolved anywhere in the
  leaderboard docs.
- Every case in `contaminated-cases.md` ends in exactly one terminal state:
  clean-resolved, clean-failed, or still-ambiguous — none left as bare "solved".
- The restated leaderboard shows the contaminated delta, not just a new number.

## Done

- `contaminated-cases.md` "Current count" is driven to zero ambiguous: each case is
  clean-resolved, clean-failed, or explicitly parked as ambiguous with its blocker.
- The published benchmark count reflects only `official_harness` clean receipts.
- The score correction is auditable: old contaminated receipts are relabelled, not
  erased, and the delta is shown.

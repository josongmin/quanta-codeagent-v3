# Adversarial final plan

Goal:
- Recover visible our-only failures without overclaiming stale screenshots, infra loss, or mixed-arm effects.

Current state:
- Source set: `our-only-misses.ids` from the visible screenshot crop.
- Active rerun set: `active-rerun.ids` / `active-rerun.jsonl` (21 instances).
- Historical-now-resolved set: `historical-now-resolved.ids` (2 instances).
- Active rerun session: `bench-ouronly-v3strict-pool-0621`.
- Active rerun log: `active-rerun.pool.log`.

Adversarial audit conclusions:

1. The screenshot is not a reliable active-miss source.
- `pytest-dev__pytest-5787` and `sympy__sympy-17630` already have clean sidecar PASS receipts.
- Do not include them in the active unresolved denominator.

2. Some cases are global hard cases, not quanta-specific embarrassment.
- `sphinx-doc__sphinx-7462` and `sympy__sympy-16597` are public hardset/ceiling-listed.
- `django__django-11820`, `astropy__astropy-13033`, `django__django-14315`, `mwaskom__seaborn-3187` are H-tier locally.
- Do not use these as evidence that the current profile is broadly broken.

3. The actionable failures are split across three different mechanisms.
- Owner-surface miss:
  - `sphinx-doc__sphinx-7462`: one gold file hit, second gold file missed.
  - `django__django-14315`: multi-site base + postgresql co-change missed.
  - historical `sympy__sympy-17630`: symptom file patched, root file missed.
- Right-file semantic near-miss:
  - `pylint-dev__pylint-4970`: right file, guard in wrong lifecycle function.
  - `django__django-11820`, `django__django-12308`: right file touched, exact logic failed.
- Breadth/under-scope:
  - `sympy__sympy-12489`: generated patch far smaller than broad gold change.

Execution plan:

Phase 0: Protect measurement validity
- Keep `historical-now-resolved.ids` out of the active unresolved denominator.
- Keep all runs on official harness with serial grading.
- Keep `QUANTA_FULL_REMOTE_CONCURRENCY=1` for the active rerun unless explicitly switching to throughput mode.
- Do not update `docs/swebench-leaderboard.yaml` from experimental losses.

Phase 1: Baseline rerun
- Run `active-rerun.jsonl` with `agentless-v3-thin-strict`.
- Current command is already queued through pool mode and waiting for boxes to go idle.
- Primary readout:
  - resolved ids
  - unresolved ids
  - `empty_patch`
  - `harness_error`
  - termination mix
  - turns and patch bytes
- Stop condition:
  - If there is any `harness_error`, `lost`, or box-loss cluster, do not interpret quality. Fix ops first.
  - If run is clean, promote only the flipped ids into the recovered ledger.

Phase 2: Owner-surface arm
- Target only owner-surface failures and fresh unresolved cases with signs of partial gold-file hits.
- Run `agentless-v3-thin-strict-closure-select` against that subset only.
- Success criteria:
  - `sphinx-doc__sphinx-7462` touches both `sphinx/domains/python.py` and `sphinx/pycode/ast.py`.
  - `django__django-14315` touches both base and backend client surfaces.
  - No new floor regressions on right-file near-miss cases.
- If it wins only on these cases, do not make it global default. Keep it as a targeted selector arm.

Phase 3: Near-miss semantic arm
- Target right-file failures where gold file is hit but logic/lifecycle is wrong.
- Do not solve this with broader localization.
- Candidate fix direction:
  - Add a pre-submit "lifecycle placement" critique for tiny patches.
  - Add explicit expected-behavior extraction from FAIL_TO_PASS before final patch admission.
  - Keep patch budget strict; the failure is exactness, not patch volume.
- Evaluation target:
  - `pylint-dev__pylint-4970`
  - `django__django-11820`
  - `django__django-12308`

Phase 4: Breadth arm
- Target only broad gold / small generated patch failures.
- Do not use this arm on tiny near-miss cases.
- Candidate fix direction:
  - Add "sibling invariant sweep" after first patch when changed API is a base class or protocol.
  - Require a second pass over subclasses / dispatch registries for inheritance-heavy repos.
- Evaluation target:
  - `sympy__sympy-12489`

Phase 5: Decision rules
- Default candidate:
  - `agentless-v3-thin-strict` remains the base if Phase 1 is clean and matches or improves prior active misses.
- Selector:
  - `closure-select` becomes a targeted fallback only if it flips owner-surface misses without causing right-file regressions.
- Repair/reprovote:
  - Run only on completed-unresolved, non-empty-patch, non-harness-error cases.
  - Do not compare it directly against selector arms.

Operational next step:
- Monitor `bench-ouronly-v3strict-pool-0621`.
- It is currently waiting for live quanta-bench boxes to go idle.
- Once the pool starts, collect `report-*.json`, append a clean readout next to this plan, and then build the Phase 2 subset from unresolved cases only.

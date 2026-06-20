# RCA summary for visible our-only miss set

Scope:
- Source set = `our-only-misses.ids` from the visible screenshot crop.
- Current rerun set = `active-rerun.ids`.
- Historical-only set = `historical-now-resolved.ids`.

Corrections before interpreting the screenshot:
- `pytest-dev__pytest-5787` is not an active miss anymore.
  Evidence: `sidecar-harvest-nondjango-2026-06-19` resolved receipt and leaderboard correction.
- `sympy__sympy-17630` is not an active miss anymore.
  Evidence: `sidecar-harvest-nondjango-2026-06-19` resolved receipt and leaderboard correction.

Primary RCA clusters:

1. Historical/stale screen state
- `pytest-dev__pytest-5787`
- `sympy__sympy-17630`
- Meaning: the screenshot mixes old miss receipts with newer sidecar PASS receipts.

2. Globally hard, not "only we fail"
- `sphinx-doc__sphinx-7462` is in the public hardset/ceiling list.
- `sympy__sympy-16597` is in the public hardset/ceiling list.
- `django__django-11820`, `astropy__astropy-13033`, `django__django-14315`, `mwaskom__seaborn-3187` are H-tier in local scaffold rank.
- Meaning: several visible misses are genuinely hard frontier cases, not easy public wins that only quanta dropped.

3. Localization or owner-surface miss
- `sympy__sympy-17630` historical miss patched `blockmatrix.py`, while gold was `matexpr.py`.
- `sphinx-doc__sphinx-7462` historical miss touched one gold file but missed the second gold file `sphinx/pycode/ast.py`.
- `django__django-14315` is explicitly logged as a multi-site miss: `base/client.py` plus `postgresql/client.py` co-change.
- Meaning: the agent often entered the right neighborhood but failed to carry the edit across the full owner surface.

4. Near-miss semantics inside the right file
- `pylint-dev__pylint-4970` touched the gold file exactly, but the guard went into `_compute_sims()` instead of `run()`.
- `django__django-11820` touched the gold file exactly and still graded unresolved.
- `django__django-12308` touched the gold file exactly and still graded unresolved.
- Meaning: these are not gross search failures; they are exact-fix / exact-line / exact-logic failures.

5. Large-patch breadth gap
- `sympy__sympy-12489` is documented as a broad subclassing change where the generated patch was far smaller than gold.
- Meaning: the failure mode is under-scoped synthesis, not simply picking the wrong repo area.

Rerun implication:
- Keep stale receipts out of the "active unresolved" rerun set.
- Expect the active rerun to contain a mix of:
  - true H-tier hard cases,
  - multi-file/localization failures,
  - semantic near-misses inside the right file.
- `agentless-v3-thin-strict` rerun should be read mainly against:
  - empty-patch / harness-error regression,
  - turn and patch-size efficiency,
  - whether multi-site and near-miss cases flip.

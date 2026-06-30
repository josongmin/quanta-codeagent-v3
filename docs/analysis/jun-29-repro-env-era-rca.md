# jun-29 — repro/test ENV-ERA RCA + the SOTA++ fix (evidence)

> Evidence log for the bench repro-exec env-era bug discovered while validating the
> repro-grounding feature on a box. RCA-grade: every claim is backed by a box-run
> artifact or a local uv reproduction. The headline: a confound that inflated the
> repro `exec_failed` metric (and thus the grounding A/B) was an ENV bug, not
> repro-gen quality — and fixing it is a corpus-wide win.

## TL;DR

- **Bug:** the per-instance repro/test env (`uv run --with-editable .`) **free-resolved
  deps to LATEST**, so an OLD instance got a NEW dep that broke its own API. Canary:
  sphinx-doc__sphinx-8595 (v3.5, created 2020) → jinja2>=3.1 removed `environmentfilter`
  → `import sphinx` died → every repro candidate a spurious `exec_failed`/`infra`.
- **Non-deterministic:** a warm uv cache sometimes resolved a working jinja2 (the
  original A1 run saw `test_errored`, not import-death); a fresh spot box resolved
  latest → broke. So the metric flickered between "model setup error" and "env import
  death" for the SAME instance.
- **Fix (SOTA++):** apply the official SWE-bench era pins — `pip_packages`
  (`Jinja2==3.0.3`) **merged** with the `pre_install` dep-caps
  (`sphinxcontrib-applehelp<=1.0.7`, `markupsafe<=2.0.1`, `alabaster<0.7.12`) — as uv
  `--with`, deduped by package (pip wins). Gated OFF when the python was floored
  off-era (era native pins have no wheel). NO setup.py edit, NO date cutoff, NO build
  break.
- **Validated on box:** sphinx-8595 repro **0/5 → 5/5 reproduced**.
- **Impact on grounding:** the "~40% exec_failed" that motivated the repro-grounding
  feature was **dominated by this env bug**, not by the model's hand-rolled-setup
  quality. With the env fixed, the model's hand-rolled repro reproduces fine WITHOUT
  grounding. Grounding's true value is now **unmeasured** (see disposition below).

## RCA evidence (box artifacts)

Four canaries on sphinx-doc__sphinx-8595, grounding knob ON:

| canary | env state | A1 repro outcome | note |
|---|---|---|---|
| 1 (pre-fix) | fresh box, latest jinja2 | 4/5 `infra_unavailable` (`ImportError: environmentfilter`) + 1 `test_errored` | env import-death dominant |
| 3 (`--exclude-newer` attempt) | era date cutoff | 5/5 build-fail (`build backend returned an error`) | date-cutoff broke the editable BUILD — net-negative, reverted |
| 4 (pip_packages fix) | `Jinja2==3.0.3` pin | **5/5 reproduced** | jinja2 import fixed; but pip_packages ALONE left sphinxcontrib uncapped → `Sphinx()` `VersionRequirementError` for the suite (closed by the pre_install dep-caps, CP1) |

- canary-1 stderr (a candidate): `ImportError: cannot import name 'environmentfilter' from 'jinja2'` at `sphinx/util/rst.py:21` → `from sphinx.application import Sphinx` dies at module load.
- Local reproduction: `uv run --python 3.9 --with jinja2 python -c "from jinja2 import environmentfilter"` → ImportError (jinja2 3.1.6); `--with "Jinja2==3.0.3"` → OK (environmentfilter present, compatible markupsafe auto-pulled).
- Local validation of the full sphinx pin set (pip_packages + pre_install caps):
  `uv run --python 3.9 --with Jinja2==3.0.3 --with sphinxcontrib-applehelp<=1.0.7 --with markupsafe<=2.0.1 --with "alabaster>=0.7,<0.7.12" ...` → `import sphinx.application` + `sphinxcontrib` succeed.

## The fix (landed)

- `specEraPins(repo, version)` (src/runner/batch/corpus/project-env.ts): merge
  `specPipPackages` (priority) with the dep-constraints extracted from
  `specPreInstall` sed REPLACEMENTS, dedup by distribution name. Returns `[]` when
  `resolvePythonForRepoVersion(...).pythonFloored` (era native pins would source-build
  fail on the floored python — astropy 1.3, sklearn 0.20-0.22: free-resolve instead,
  no regression).
- `buildProjectEnvUvRunArgv` folds `specEraPins` into the `--with` deps.
- regen tool now dumps `pip_packages`; repo-version-specs.ts regenerated (66 repos).
- Commits: `477861577` (pip_packages), `f3cf0b785` (pre_install dep-caps + floored
  gate), `0ac4bf636` (revert the --exclude-newer attempt), `a81f9baca` (dead-code
  cleanup of the reverted chain).

## Grounding disposition (honest)

The repro-grounding feature (inject existing-test SETUP SKELETONS to stop the model
hand-rolling framework setup) was premised on "exec_failed = hand-rolled-setup
quality". The canary shows that premise was **confounded by this env bug** — and on
n=1, grounding provided ZERO value (the model IGNORED the injected exemplars and still
hand-rolled, but once the env was fixed the hand-roll reproduced fine).

- **NOT shelved** — the feature is leak-safe, fully inert default-OFF, and the
  measurement rig is built (telemetry now readable on every path, CP2). The premise is
  confounded, not proven invalid: a genuine `test_errored` class (env OK, the model's
  setup logic errors) may still exist on other instances.
- **The gate** = a broad off-vs-on A/B **with the env fix applied to both arms**,
  restricted to `engaged=true` instances, readout = `exec_failed`/`test_errored` rate
  delta. Until it runs, grounding's value is **unmeasured**; the n=1 canary informs
  framing, it does not settle efficacy.
- **Deferred (measure-first):** the "model ignores exemplars" finding suggests the
  exemplar framing is too weak (skeletons ship only signatures, not copyable
  setup-call lines). Keeping setup-call lines (eliding only the assertion tail) +
  a stronger imperative header is a candidate improvement — but it touches the
  load-bearing no-leak strip, so it is NOT done speculatively on an unmeasured
  feature; revisit only if the A/B shows grounding has potential.

## SOTA++ faithfulness audit (vs the official SWE-bench harness)

An adversarial audit compared the uv approximation against the official env-build
(`MAP_REPO_VERSION_TO_SPECS` + `run_evaluation`). Two real gaps were closed; four are
audit-confirmed acceptable simplifications.

**Closed (landed):**
- **install `.[extra]`** — official runs `pip install -e .[test]`; we used bare
  `--with-editable .`. The "pip_packages always carries [test] deps" assumption is
  FALSE for sphinx (`[test]` = html5lib/cython/typed-ast, absent from pip_packages →
  HTML-writer tests ImportError; 44 instances). Fix: `installExtra` → `--with-editable
  '.[extra]'` (gated on !floored). 63 cells have an extra.
- **eval_commands** — `specEvalCommands` existed but was unwired; django's locale
  exports (LANG/LC_ALL/PYTHONIOENCODING/LANGUAGE; 1.11-3.2, ~150 instances) never set
  → locale-sensitive i18n tests flipped under C locale. Fix: `evalEnvExports` folds the
  `export KEY=VAL` subset into the exec env (root-only `locale-gen` skipped).

**Acceptable non-SOTA simplifications (audit-confirmed with Verified instance counts):**
- matplotlib qhull/apt build steps (≤34 subset, out of uv scope — needs host libs).
- conda `packages` field dropped (sympy/xarray transitively covered; sklearn
  pandas/matplotlib overlaps the already-floored/native-blocked cohort).
- coarse floor gate (drops pure-python pins on floored cells — only 4 astropy-1.3
  instances hit it, and they're independently native-build-blocked anyway).
- `environment_setup_commit` ignored (building from base_commit's own setup.py is the
  correct dependency authority for that commit — defensible, no concrete failure).

Empirical: all 689 spec cells produce well-formed argv (valid editable target, KEY=VAL
env). The era-pin core (sphinx Jinja2==3.0.3 + applehelp caps on non-floored cells) is
SOTA-matching.

## Empirical validation (100-diligence)

- **Box:** sphinx-8595 (Verified) repro 0/5 → 5/5 reproduced under the full era pins.
- **Resolution (pin-set mutual-resolvability, uv ephemeral env):** the high-pin
  Verified-era cells all resolve cleanly with NO conflict — matplotlib 3.5 (15 pins,
  py3.11), astropy 4.3 (py3.9), xarray 2022.03 (py3.10), seaborn 0.12 (py3.9), flask
  2.0 (py3.9), sphinx 3.5 (jinja2 chain). 
- **Shape:** all 689 spec cells produce a well-formed argv (valid `.`/`.[extra]`
  editable target, KEY=VAL env entries) — 0 bad.

### Known edge — version-newer-than-era pin conflict (zero Verified impact)

The official `pip_packages` is **version-SHARED** across a repo's versions: sphinx
3.x AND 8.x both pin `Jinja2==3.0.3`. For the OLD versions (Verified) that's correct
(sphinx 3.x needs jinja2<3.1). For a NEW version (sphinx 8.1 needs jinja2>=3.1) the
pin CONFLICTS: `uv run --with Jinja2==3.0.3 --with-editable .` → `sphinx 8.1.3 depends
on jinja2>=3.1 … requirements unsatisfiable` (verified). The official harness's
sequential `pip install` lets the editable upgrade jinja2 (the pin is overridden);
uv's STRICT single-resolution does not, so we'd fail where pip succeeds.
- **Impact on Verified = ZERO**: sphinx 8.x is 2024, Verified is 2023 — no Verified
  instance uses a version newer than its era pins.
- **Closure path (scoped, measure-first):** SWE-bench Live/Pro MAY carry newer
  versions; the robust fix is a RUNTIME resolution-fallback (on a uv era-pin conflict,
  retry without the era pins) in the repro/test exec port — deferred until a Live/Pro
  run actually hits it, to avoid speculative exec-path changes.

## Residual env gaps (follow-up, low priority)

- The regen drops the official `packages` (conda) field; a few repos (pvlib `pandas
  scipy`, pydicom `numpy`) name bare conda deps not in pip_packages — verify only if
  they show no-repro.
- A future re-enable of an era date-cutoff must NOT conflict with the pip_packages
  pins (e.g. `--exclude-newer 2021-09` would filter out `Jinja2==3.0.3`, published
  2021-11) — use per-package carve-outs if ever revived.

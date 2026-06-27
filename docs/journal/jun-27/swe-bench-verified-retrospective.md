# SWE-bench Verified — jun-27 retrospective + failure RCA

Campaign outcome, a 3-pass audited root-cause analysis of every failure
(1차 primary → 적대 adversarial → 객관 objective), cross-referenced against 134
frontier scaffolds, and the spot-resume infra built alongside.

---

## 1. Outcome

- **green 37** (from ~11 at day start). Queue drained 132 → 8.
- 90 unique instances in the campaign window: **34 green · 55 real-fail · 1 empty · 0 infra · 0 auth/throttle.** Final picture has **no measurement confounds** (early box-loss churn was requeued and re-ran cleanly).

### green by repo
django 28 · sympy 2 · sphinx 2 · astropy 2 · scikit-learn / requests / matplotlib 1 each. django-11087 is **frontier-0** (no other of the 134 scaffolds solved it — a genuine our-only win).

### winning config (SSOT)
```
preset = agentless-v6-singlepass-execfull   (agentless-v1 localize + bench-in-loop-exec:full)
QUANTA_BENCH_NONEMPTY_FALLBACK=1  QUANTA_BENCH_CONCURRENCY=1  model=gpt-5.5 (reasoning.summary=auto)
exec = full-remote on-demand c7i.4xlarge, ap-northeast-2 · tools/red-campaign.sh (6/box, box-loss→requeue)
```

---

## 2. 1차 어딧 (primary) — classify from sidecar signals

Per-instance signals: `gradeBreakdown` (failToPass/passToPass failed), `reproTest`
(reproduced?), `touchedFiles`, `llmEvidence*`. NOT gold-patch matching.

### Failure modes (the 55 real-fails)
| mode | n | % | meaning |
|---|---|---|---|
| synthesis (repro OK, patch wrong) | 37 | 67% | oracle works, localization right, edit wrong |
| no-repro (no working oracle) | 11 | 20% | agent never got a reproducing test |
| regression (broke pass-to-pass) | 6 | 11% | patch broke other tests |
| other | 1 | 2% | |

### Cross-tab: root-cause × frontier solvability (134 scaffolds)
solvability = how many of 134 scaffolds resolved the instance (easy 40+ · med 15-39 · hard 3-14 · rare 1-2 · **ceiling = 0, nobody solved**).

| root-cause | easy | med | hard | rare | ceiling | total |
|---|---|---|---|---|---|---|
| synthesis | 3 | 11 | 6 | 5 | **12** | 37 |
| no-repro | 2 | 5 | 3 | 0 | 1 | 11 |
| regression | 0 | 0 | 5 | 0 | 1 | 6 |
| other | 0 | 1 | 0 | 0 | 0 | 1 |
| **total** | **5** | **17** | **14** | **5** | **14** | **55** |

**Reading:** 22 (easy+med) are **our scaffold gap** (frontier solves, we fail = fixable). 14 are **ceiling** (nobody solves = dataset limit, not our fault). 19 hard/rare are marginal.

---

## 3. 적대 어딧 (adversarial) — challenge the primary via trajectory + grade deep-reads

Each primary bucket was attacked (false-oracle? grading artifact? mislabeled?) by reading trajectories (`trajectory-i-*.jsonl`) + box artifacts (`observe-i-*.tar.b64`) + grade verdicts.

### 3a. "synthesis" — CONFIRMED (4/4 sampled), with a signal caveat
django-11206 / 11265 / 13512 / 14140 all confirmed: clean official grade (`verdict=ok`, passToPassFailed=0), localization correct, patch **under-satisfies the hidden fail-to-pass contract** (over-narrow branch in 11206/14140; under-scoped fix in 11265/13512).
- **Mechanism (uniform):** the agent validates against its OWN repro + the *pre-existing* tests (both green) and declares done — it **never runs the issue's newly-added fail-to-pass tests**. Right place, green self-check, wrong/narrow edit.
- ⚠️ **Caveat:** `reproTest.reproducedCount>0` is NOT a reliable "oracle valid" signal — 11265's seeded repro threw `NameError`, 13512's imported a nonexistent `django_mysql`; the agent self-authored replacements. reproducedCount counts script execution, not target-behavior reproduction.

### 3b. "regression" — bucket COLLAPSES (only 1 of 6 real)
| id | grade valid? | verdict |
|---|---|---|
| astropy-7606 | NO — gold did not resolve (`grader_invalid`) | **grading-confound** |
| astropy-8707 | NO — `grader_invalid` (7/11 p2p fail) | **grading-confound** |
| astropy-8872 | NO — `grader_invalid` (80/80 p2p fail = env breakage) | **grading-confound** |
| astropy-13398 | valid but timeout + `multi_file_drift`, f2pFailed=4 | not a clean regression (incomplete/drifted run) |
| pylint-8898 | valid but `timeout`, f2pFailed=1 | incomplete fix + incidental 1-test p2p break |
| django-14170 | **VALID** (`real-fail`, f2pFailed=0, 9 p2p broken) | **REAL regression** |
→ **1 genuine regression, 3 grading-confounds, 2 timeout/incomplete.** The 3 astropy confounds are NOT model failures (the reference patch itself doesn't resolve in our grader) and must be excluded from the denominator.

### 3c. "no-repro" — splits into TWO mechanisms (one cheaply fixable)
| id | frontier | mechanism | fixable? |
|---|---|---|---|
| scikit-14087 | 60 | uv editable build fails — no Cython/numpy build deps | **YES** — add scikit-learn to `REPO_ENV_OVERRIDES` |
| scikit-14983 | 48 | same build-backend failure | **YES** — same |
| scikit-25747 | 15 | same (meson era, still needs build deps) | **YES** — same |
| sympy-23413 | 21 | repro imported numpy; repro-exec env only `--with setuptools` | YES — pin/guard import |
| pylint-7080 | 23 | repro WRITTEN + ran but PASSED on buggy base | NO — repro-design (wrong assertion) |
| sympy-12489 | 18 | repro PASSED on base (tests wrong aspect) | NO — repro-design |
→ **4 of 6 = env/build-dep gap** (root: `project-env.ts REPO_ENV_OVERRIDES` only registers astropy/xarray; scikit-learn unregistered → editable build runs with no Cython/numpy). Adding one scikit-learn override (mirror the astropy `buildDeps` entry) plausibly unblocks the **two biggest scaffold-gap cases (frontier 60 & 48)**. NOT the jun-20 python-version issue (already fixed). The other 2 are genuine repro-design failures (`llmEvidenceMissingKinds: public_mwe_seed`).

---

## 4. 객관 어딧 (objective) — synthesis

**Corrected denominator:** exclude the 3 astropy grading-confounds → ~52 true model failures. Of those, **~22 are scaffold gap (frontier-solvable), ~14 are ceiling.**

**Leverage, ranked:**
1. **Execution loop bound to the REAL oracle (synthesis, 37 / ~67%) — #1 by far.** The agent self-validates on its own repro + pre-existing tests, blind to the hidden fail-to-pass test → ships over-narrow patches. Lever: don't accept a patch until it flips the actual failing test (a stronger/real oracle), or N-best with a "does this satisfy the full contract" critic. Frontier solves these → it's our scaffold, not the model ceiling.
2. **Repro-gen build path for scikit/old-C-extension repos (no-repro env, ~4 incl. the 2 highest-value).** ⚠️ UPDATE: the first attempt (a `scikit-learn/scikit-learn` buildDeps override in `REPO_ENV_OVERRIDES`, mirroring astropy) was VERIFIED INEFFECTIVE by a single-case box smoke (scikit-14087, c7i.4xlarge, pre-broad-run) and REVERTED. Box run.log: uv `--with-editable .` still `Failed to resolve --with requirement / build backend returned an error`, Cython C-extensions uncompiled (`No module named sklearn.__check_build`). Declaring build deps is NOT enough — the uv editable build can't COMPILE old scikit's numpy.distutils-era extensions. KEY signal: the docker GRADING path builds scikit fine (14629 stayed green with reproInstalled=false), so the real fix is to route repro-gen through a working build (e.g. the docker/grade env, or `python setup.py build_ext --inplace` before repro), NOT a deps declaration. Harder than first scoped.
3. **Grading-confound hygiene** — astropy gold-not-resolve (`grader_invalid`) must be auto-excluded from "miss" counts; 3 cases here were phantom regressions. Trust the grader's own `grader_invalid` verdict.
4. **Tail (lower ROI):** 1 real regression (django-14170 → regression-gate: run p2p before accept), 2 repro-design failures, 2 timeout/incomplete (raise box deadline / reduce drift), and the 14 ceiling cases (don't chase).

**Bottom line:** the headline "67% synthesis" survives adversarial scrutiny and is the dominant, scaffold-fixable bottleneck (execution-feedback). The second lever (scikit-learn build override) is a near-free recovery of the two highest-frontier-solvability misses. The regression bucket was mostly grading noise. ~14 of the failures are a genuine dataset ceiling nobody clears.

---

## 5. Competitor cross-reference (134 frontier scaffolds)
- Our 55 fails: 22 frontier-solvable (5 easy + 17 med) = **scaffold gap**; 14 frontier-0 = **ceiling**; 19 hard/rare.
- Our 37 greens include **1 frontier-0** (django-11087) — solved something none of the 134 did.

## 6. Infra lessons + spot-resume (built this session)
- **otel src→tools import crashed every full-remote box, masked as "box-loss"** (`Cannot find module`; boxes rsync src/ only). ~1h 0-green misdiagnosed before reading the box run.log. Lesson: box-loss ≠ infra — read the box run.log tail. (`jun-27-otel-src-import-boxloss-mask`)
- **spot-resume infra** (default-OFF): per-turn cassette → S3, replay on a fresh box. Determinism solved via deterministic workdir + a canonicalizing request-hash (validated: real-cassette perturbation 331/331, real-S3 cross-box match 3/3). AWS provisioned via CLI (bucket `quanta-bench-resume-527687867704`, role/profile). Turn-on pending iam:PassRole + env flip + one live EC2 cycle. (`jun-27-bench-spot-resume`, `docs/plans/jun-27-bench-spot-resume-s3.md`)

## Appendix — scaffold-gap cases (frontier easy/med, we failed) — fix targets
```
no-repro/env:  scikit-14087(f60) scikit-14983(f48) scikit-25747(f15) sympy-23413(f21)
synthesis:     django-11206(f42) django-11265(f41) django-13512(f40) django-16560(f37)
               pylint-6386(f35) django-14140(f35) django-14376(f26) pylint-4970(f23)
               matplotlib-20676(f20) sympy-13974(f20) django-12273(f17) django-12325(f16)
               sphinx-8265(f16) django-15563(f15)
repro-design:  pylint-7080(f23) sympy-12489(f18)
other:         sphinx-8056(f21)
```
(f = # of 134 frontier scaffolds that solved it)

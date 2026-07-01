---
task: rstan-to-pystan
category: data-science
difficulty: medium
tags: [pystan, rstan, gaussian-process]
expert_min: 180
junior_min: 2880
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/rstan-to-pystan:20251031
---

# rstan-to-pystan

**Goal** — Port a provided RStan Gaussian-process regression script (`/app/gp_rstan.R`) to Python using **PyStan 3.10.0** (no R/RStan, no cmdstan), run posterior sampling with `random_seed=1`, and write posterior means to `alpha_est.csv`, `sigma_est.csv`, `rho_est.csv`, `beta_est.csv`.

**Solution shape** — Heavy env setup: apt installs `build-essential`, gfortran, BLAS/LAPACK, cmake; adds deadsnakes PPA for python3.10; builds **httpstan 4.13.0 from source** (poetry build + wheel install) for ARM compat; pip-installs pystan/pandas/numpy. Then writes `pystan_analysis.py` with an embedded Stan model (ARD sq-exp kernel via `functions` block, GP with cholesky, `generated quantities` for prediction), maps RStan hyperparams to PyStan names (`adapt_delta`→`delta`, `max_treedepth`→`max_depth`, `iter`→warmup+samples), samples 4 chains, dumps means. Also optimizes memory by making K/L_K locals. ~2 files, ~200 lines total.

**Verifier** — pytest: confirms R/rstan are NOT installed; all four CSVs exist; each posterior-mean value falls in a tight empirically-derived range (e.g. alpha∈[1.08,1.1], sigma∈[0.133,0.136], per-element rho/beta ranges). Binary 0/1.

**Difficulty drivers** — Multi-step: painful from-source httpstan build on ARM, R→Python API/hyperparameter translation, and Bayesian-GP domain knowledge. Long-running MCMC (verifier timeout 1800s). Numerical accuracy gated by seed=1 plus functionally-equivalent model/priors — a wrong prior or treedepth silently moves the posterior mean out of range.

**quanta attack points** — `container_exec` for install/build/sample steps (each has a clear exit code). No interactive component, so no `pty_*`. Main failure risks: httpstan build failing on ARM, and matching R hyperparameter semantics precisely. The exit-code loop helps for build/install debugging but the final accuracy check is a slow, seed-sensitive sampling run — limited fast feedback.

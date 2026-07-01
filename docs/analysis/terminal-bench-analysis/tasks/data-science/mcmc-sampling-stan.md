---
task: mcmc-sampling-stan
category: data-science
difficulty: hard
tags: [R, stan, bayesian-statistics, mcmc]
expert_min: 180
junior_min: 2880
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/mcmc-sampling-stan:20251031
---

# mcmc-sampling-stan

**Goal** — Fit a hierarchical Bayesian binomial model (y_i~Binomial(n_i,theta_i), theta_i~Beta(alpha,beta), prior (alpha+beta)^(-5/2)) in R/Stan on `/app/data.csv`; write `hierarchical_model.stan`, `/app/analysis.R`, and posterior-mean files for alpha and beta.

**Solution shape** — ~140-line bash. `apt-get` installs gfortran/lapack/blas (pinned versions), then `remotes::install_version` pins Rcpp/RcppEigen/BH/StanHeaders and RStan 2.32.7 (compiled from source with a custom `~/.R/Makevars`). Heredocs write the Stan model — the key trick is a reparameterization u=alpha/(alpha+beta), v=(alpha+beta)^(-1/2) with uniform priors to induce the (alpha+beta)^(-5/2) prior — and an `analysis.R` that runs `rstan::sampling` (4 chains x 100k iters, seed 1) and writes the two mean txt files.

**Verifier** — pytest: RStan importable; Stan model parses via `stan_model`; `analysis.R` runs without fatal errors; MCMC output contains "SAMPLING FOR MODEL"/"Chain"/"Elapsed Time"; alpha mean in [2.84,2.91] and beta mean in [16.1,16.7]. reward binary 0/1. Note: the verifier re-runs the full 400k-iter sampling (timeout 1800s), so the run is genuinely long.

**Difficulty drivers** — Deep Bayesian/Stan domain knowledge (the prior reparameterization is the crux and non-obvious), heavy source-compile toolchain setup (RStan from source with pinned deps), long-running MCMC, and narrow numeric acceptance windows on the posterior means.

**quanta attack points** — `container_exec` throughout (apt, R -e installs, Rscript); no interactivity, so no `pty_*` needed. Main failure risk: getting the prior reparameterization wrong (samples land outside the tight alpha/beta ranges) or RStan source-build failing/timing out. The exit-code loop helps only weakly — each iteration is a multi-minute compile+sample cycle, so feedback is slow and the correctness gate is a numeric range, not a stack trace.

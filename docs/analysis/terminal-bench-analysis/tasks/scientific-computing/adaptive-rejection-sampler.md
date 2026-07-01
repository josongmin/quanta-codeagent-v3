---
task: adaptive-rejection-sampler
category: scientific-computing
difficulty: medium
tags: [applied-statistics, adaptive-rejection-sampling, Bayesian-inference, simulation]
expert_min: 180
junior_min: 480
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/adaptive-rejection-sampler:20251031
---

# adaptive-rejection-sampler

**Goal** — Implement the Gilks & Wild (1992) adaptive-rejection sampler in R at `/app/ars.R`: a primary `ars` function (validates inputs, checks log-concavity during sampling), auxiliary modular functions, a `test` function printing "NAME: PASS/FAIL" with mean/sd, and generate `normal_samples.txt`/`exponential_samples.txt`.

**Solution shape** — `solve.sh` installs openssl + R, then **decrypts a pre-authored reference implementation** from `protected.tar.gz.enc` (`openssl aes-256-cbc -pbkdf2 -pass pass:adaptive-rejection-sampler-2024`) which contains the real `ars.R` (upper/lower hull `createUpHull`/`createLowHull`, `startingpoints`, etc.). It then patches in n<=0/domain input validation via sed, appends a `test()` function, and runs several R driver scripts (`create_samples.R`, `test_ars.R`, `demo_ars.R`) to emit the required sample files and PASS/FAIL output. Large orchestration script; core algorithm ships encrypted.

**Verifier** — pytest (uvx, invokes Rscript). Checks `ars.R` exists with an `ars` function; sources it and generates normal samples (n=1000, mean~0, 0.8<sd<1.2); a `test` function exists and prints ": PASS"/": FAIL" + mean stats; sample file(s) exist with valid distribution stats; >=3 functions (modularity); >=2 error-handling constructs; rejects negative n / invalid domain; handles a non-log-concave (bimodal) density. reward 0/1.

**Difficulty drivers** — Real numerical-statistics algorithm (piecewise-linear upper/lower log-density hulls, envelope/squeeze rejection, log-concavity detection), stochastic-output testing, R idioms, plus modular-design and input-validation requirements. NOTE: the shipped solution sidesteps authoring by decrypting a reference — an agent doing it honestly must implement the sampler from the paper.

**quanta attack points** — `container_exec` to install R, author/run `ars.R`, and check statistical outputs. Main failure risk is the numerically-tricky hull construction and the log-concavity check that must reject a bimodal density while accepting normal/exp. The iterate-until-tests loop helps for the structural/validation checks, but the distributional assertions are stochastic — the agent must reason about correctness, not just re-roll seeds. No interactive tooling; pty not needed.

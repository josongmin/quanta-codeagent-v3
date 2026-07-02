---
task: largest-eigenval
category: mathematics
difficulty: medium
tags: [coding, optimization, constraint, numerical-approximation]
expert_min: 60
junior_min: 180
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/largest-eigenval:20251031
---

# largest-eigenval

**Goal** — Complete `find_dominant_eigenvalue_and_eigenvector` in `/app/eigen.py` for a general (non-symmetric, possibly complex-eigenpair) real square matrix up to 10×10. Must satisfy `A @ v = λ v` for the largest-magnitude eigenvalue AND run **consistently faster** (median-of-many) than the numpy `np.linalg.eig` reference in `/app/eval.py`. May install packages or use other languages, but entrypoint stays a Python function.

**Solution shape** — Bash: `pip install eigenpy==3.10.3`, then overwrite `eigen.py` to call `eigenpy.EigenSolver` (Eigen C++ backend), pull eigenvalues/eigenvectors, `argmax(|λ|)`. The lever is swapping numpy's LAPACK `eig` for a faster C++ solver on small matrices, not a hand-rolled power-iteration. One file rewritten (~12 lines).

**Verifier** — pytest parametrized over sizes 2..10: correctness — `|λ|` matches reference dominant eigenvalue magnitude (`np.isclose`), eigenpair valid; and **speed** — candidate median time per call must be strictly `< ` reference median, run in an isolated ProcessPoolExecutor over N=100 matrices. reward binary 0/1.

**Difficulty drivers** — Beating optimized numpy/LAPACK on tiny matrices is non-obvious (the naive rewrite is *slower*); requires knowing a faster small-matrix eigensolver or C++ binding. Correctness on complex, non-symmetric eigenpairs adds numerical care. The speed gate is comparative and can be flaky, so the solution must be robustly faster, not marginally.

**quanta attack points** — `container_exec` iterate-with-`eval.py`: the provided harness gives immediate timing/correctness feedback, so the exit-code loop is genuinely useful here (agent can benchmark each candidate). Main risk is producing a *correct but not-faster* solution — many implementations pass allclose yet lose the timing gate. No interactivity; pure numerical/perf engineering.

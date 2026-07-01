---
task: distribution-search
category: machine-learning
difficulty: medium
tags: [coding, statistics, machine-learning]
expert_min: 120
junior_min: 240
skill_class: NUMERIC-SCI
terminal_native: low
docker_image: alexgshaw/distribution-search:20251031
---

# distribution-search

**Goal** — Construct a valid probability distribution over vocab size 150,000 whose forward KL(P‖U) = 10.0 AND backward KL(U‖P) = 10.0, both within ±0.001. Save the numpy vector to `/app/dist.npy`.

**Solution shape** — Pure numerics, no env setup: `solve.sh` writes `search_distributions.py`. It parameterizes P as a **three-level step distribution** (A tokens at prob p_h, B at p_m, C at p_l), reducing the two KL constraints + normalization to a 3-equation nonlinear system solved via damped Newton with line search. A 2-level continuous seed (bisection) gives good initial guesses; an outer loop scans integer counts (A around ~5% of V, B on a Fibonacci-ish grid) until max KL error ≤ tol, then materializes and renormalizes the 150k vector. 1 file, ~300 lines.

**Verifier** — pytest + numpy: file loads, 1-D, size exactly 150000, all finite/positive/≤1, sum≈1 (tol 1e-5), and both KL divergences within 1e-3 of 10.0 (recomputed after renormalization). Binary 0/1.

**Difficulty drivers** — Math-heavy: recognizing that both-directions-KL=10 constrains distribution *shape* (few heavy + many light tokens), deriving closed KL forms, and building a numerically stable root-finder (log-space, overflow-safe). Not multi-step in shell; the whole difficulty is the algorithm. Verifier timeout is generous (3600s).

**quanta attack points** — Code-authoring; `container_exec` to run the script and read printed KL values (script self-verifies before saving). No TUI. Main risk is numerical: a naive optimizer overshoots the 1e-3 tolerance or produces non-positive probs. The exit-code "iterate until tests pass" loop works well since the KL checks are deterministic and fast to recompute locally.

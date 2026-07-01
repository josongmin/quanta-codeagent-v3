---
task: model-extraction-relu-logits
category: mathematics
difficulty: hard
tags: [security]
expert_min: 480
junior_min: 2400
skill_class: ADVERSARIAL-SEC
terminal_native: low
docker_image: alexgshaw/model-extraction-relu-logits:20251031
---

# model-extraction-relu-logits

**Goal** — Given a black-box 1-hidden-layer ReLU net (`forward(x)` returns a single float, input dim 10, hidden width unknown), write `/app/steal.py` that queries `forward()` to recover the first-layer weight matrix A1 up to per-neuron permutation and scaling, saving it to `/app/stolen_A1.npy`.

**Solution shape** — `solve.sh` writes `/app/steal.py` implementing the Carlini et al. cryptanalytic model-extraction attack. It sweeps random 1-D lines through input space via a recursive binary "critical-point" search (2-linear test from Jagielski et al.) to locate ReLU kink points, then estimates each neuron's input weight ratios by finite-difference second derivatives along each axis (with a sign-recovery step using combined directions), dedups discovered neurons by scale-invariant ratio matching, and saves the recovered rows. Pure-query attack, ~370 lines, no training-data access.

**Verifier** — pytest (uvx). Overwrites `forward.py` with a fresh known net (seed 5, A1 30x10) to prevent reward-hacking, runs `steal.py`, loads `stolen_A1.npy`, and for every original A1 row checks some stolen row matches up to a single scale factor (`ratio_diff < 1e-4`). All 30 rows must match. reward 0/1.

**Difficulty drivers** — Deep ML-security / numerical-cryptanalysis expertise (recovering weights from logit queries), high-precision floating-point critical-point finding, sign disambiguation, neuron dedup up to scale — 8h expert / 40h junior estimate. The attack must be robust to a fresh unseen network (verifier swaps it). Very hard math, minimal terminal complexity.

**quanta attack points** — `container_exec` to author steal.py and run it against forward.py. Main failure risk is numerical: tolerance tuning in the sweep/second-derivative estimation, missing neurons, or failing sign recovery — subtle math bugs that pass locally but fail the swapped-net check. The iterate-until-tests loop is weak here because the true verifier net is hidden; the agent must reason about generality, not just fit the local forward.py. Essentially a coding/math task — terminal is only the runtime.

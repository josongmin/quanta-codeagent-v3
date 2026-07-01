---
task: tune-mjcf
category: scientific-computing
difficulty: medium
tags: [mujoco, physics, simulation, numerical-optimization]
expert_min: 30
junior_min: 120
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/tune-mjcf:20251031
---

# tune-mjcf

**Goal** — Tune a MuJoCo model (`/app/model_ref.xml`, a cable scene) so simulating 2s takes <=60% of the reference wall-time while reaching the same full physics state within atol=1e-5 (no NaN/Inf). Save as `/app/model.xml`; leave `model_ref.xml` unchanged; don't alter body physical properties.

**Solution shape** — Two-line `solve.sh`: copies `model_ref.xml` to `model.xml` and `sed`-injects `<option solver="PGS"/>` after the `<mujoco model="Cable">` line — switching the constraint solver (default Newton→PGS) to cut per-step cost while keeping the same physics result. Minimal edit; the insight is which solver/option speeds up this scene without changing dynamics. `eval.py` is provided to iterate.

**Verifier** — pytest (imports mujoco). Asserts `model_ref.xml` unchanged and `model.xml` exists. Correctness: simulate both models 2s from the same jittered qpos seed, require final full-physics state `allclose(atol=1e-5)`, no NaN/Inf. Speed: time 20 runs each (trimming 5/95 percentiles), require `mean(time_model/time_ref) <= 0.6`. reward 0/1.

**Difficulty drivers** — Domain knowledge of MuJoCo's solver/integrator options and which knobs speed simulation without perturbing the physics result (the trap, per the hint, is changing body physical properties — that breaks correctness). Must hit both a 40% speedup AND 1e-5 state match, a tight joint constraint. Timing-based verification adds noise.

**quanta attack points** — `container_exec` to edit the XML and run `eval.py` for timing/correctness feedback. Main failure risk is over-tuning (e.g. increasing timestep) that speeds things up but blows the atol match, or a change that fails NaN/Inf checks. The exit-code / eval-script loop helps because the agent gets direct speedup + state-diff numbers to iterate against. No interactive tooling; pty not needed.

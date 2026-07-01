---
task: llm-inference-batching-scheduler
category: machine-learning
difficulty: hard
tags: [batching, inference, performance-optimization, scheduling]
expert_min: 45
junior_min: 450
skill_class: NUMERIC-SCI
terminal_native: low
docker_image: alexgshaw/llm-inference-batching-scheduler:20251031
---

# llm-inference-batching-scheduler

**Goal** — Given two JSONL request buckets (each request has prompt_len/gen_len), produce shape-aware batching plans (`plan_b1.jsonl`, `plan_b2.jsonl`) that assign every request to a batch with a tensor shape `(seq_align, 32, 4096)`, seq_align a multiple of 64 ≥ ceil(prompt/64)*64, ≤8 unique shapes total — while beating tight cost / pad_ratio / p95-latency / sequential-timecost thresholds from a provided analytical cost model.

**Solution shape** — `solve.sh` writes one ~300-line `solution.py`. Strategy: load requests, attach aligned prompt S and gen G; select ≤8 shared `seq_align` "shapes" via two deterministic sweeps (2D k-medoids on (S,G) with several G-weights, and G-weighted quantiles on S with several alphas); assign each request to smallest shape ≥ S; split each shape bucket along G with a DP that minimizes decode-cost + per-batch overhead (mirroring the cost model); evaluate all candidates with the real `cost_model.py` over a λ grid and pick the first that clears thresholds, tie-breaking on p95+pad. Pure-Python, no ML libs.

**Verifier** — pytest imports the task's own `cost_model`, checks: both plan files exist; input JSONL SHA256 unchanged (anti-cheat); full coverage / no dup request_ids; shapes aligned to 64 and heads/hidden match constants; ≤8 unique shapes; per-batch shape consistency and feasibility; and all four numeric thresholds per bucket. Binary 0/1.

**Difficulty drivers** — An optimization/OR problem, not systems work: must model the cost function correctly and design a packing heuristic (shape selection + G-aware batching) that jointly satisfies four tight thresholds under a hard 8-shape cap. Baseline is far above threshold, so a naive per-request or per-quantile approach fails. Getting all four metrics under bound simultaneously is the crux.

**quanta attack points** — Pure `container_exec`: write solver, run it, re-run the provided `cost_model.py` to self-score. No interactivity, low terminal-native. The exit-code loop is *highly* effective here — the cost model is provided, so the agent can build an exact local evaluator and iterate its heuristic/params until metrics fall under threshold, closely matching the grader.

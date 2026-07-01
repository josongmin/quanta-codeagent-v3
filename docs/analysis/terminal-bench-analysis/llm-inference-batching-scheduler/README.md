# llm-inference-batching-scheduler

**Goal:** Pack LLM inference requests (from two `requests_bucket_*.jsonl`) into batches with fixed tensor shapes, emitting `plan_b1.jsonl`/`plan_b2.jsonl`. Constraints: every request once, `seq_align` a multiple of 64 ≥ aligned prompt, ≤ 8 unique shapes across *both* buckets, and cost/pad_ratio/p95-latency/sequential-timecost all under tight per-bucket thresholds.

## Our result
| Model | Reward | Notes |
|-------|--------|-------|
| quanta + gpt-5.4 | 0 (fail) | 24 shapes (cap 8) + cost over threshold |
| quanta + gpt-5.5 | 1 (pass) | solved |

**gpt-5.4 failure (concrete):** `AssertionError: bucket 1 uses 24 shapes, exceeds limit of 8` and `bucket1 cost 308329942231.0 > 3.0e11` (barely over). Feasibility/coverage tests passed, but 5.4 emitted too many distinct shapes and missed the cost bar — it did not do the global shape-consolidation the ≤8 cap forces. gpt-5.5 built the constrained shape-selection + cost-aware batching that clears every threshold.

## Reference approach
`solve.sh` is the genuine solution and is substantial (~400 lines of embedded Python). It: loads both buckets, sweeps two deterministic shape selectors (2D k-medoids on (S,G); weighted quantiles on S) to pick ≤8 shared `seq_align` values, assigns each request to the smallest shape ≥ its aligned prompt, then splits each shape-bucket by generation length with a DP that minimizes decode-cost + per-batch overhead, and grid-searches a lambda-weighted score against the provided `cost_model.py`, preferring any candidate that satisfies all thresholds.

## Public leaderboard
tb-2-specific; public per-model trajectories are on the tbench.ai Terminal-Bench 2.0/2.1 leaderboard (not bulk-downloadable here). https://www.tbench.ai/leaderboard/terminal-bench/2.0

## Verifier
`tests/test_outputs.py` checks both plans exist, input SHA256 hashes are untampered, full coverage/no-dups, shapes aligned + head/hidden constants, ≤8 unique shapes per bucket AND combined, and all cost/pad/p95/sequential thresholds via `cost_model_for_tests.py`. Reward is binary 0/1.

# Terminal-Bench harness levers — solution plans (2026-07-02)

Solution plans derived from the **Terminal-Bench full-89 first run** (48/89 = 54.5%, vs leaderboard
gpt-5.5 82.7% → −28pp) and a read-every-final-message failure review. Each lever is a separate,
independently-shippable harness change with its own RFC + hellgate plan.

> Evidence base: full-89 run on box `13.124.146.106` (gpt-5.5, `-n8` supervisor), results at
> `~/tb-results/full89/<ts>/<task>__<id>/{result.json,verifier/reward.txt}` on that box; ~42 failures classified
> by reading each agent final message + cross-checking TB2 top-tier solve-rates (RDI-Foundation/terminal-bench-
> leaderboard, 68 submissions, `results/*.json` `task_rewards`). The classification counts here are a review of
> those artifacts, NOT independently re-derived from the box in this pass — treat the *seam analysis* as verified
> and the *bucket sizes* as approximate. Repo anchors for the general landscape are
> `docs/analysis/terminal-bench-analysis/FAILURE-RCA.md` and
> `docs/analysis/terminal-bench-analysis/_data/classified.json`; the full-89 memo itself currently lives in agent
> memory at `~/.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/jul-01-terminal-bench-full89-landscape.md`.

## Failure landscape (what the 54.5% is losing to)

| bucket | size | mechanism | lever | doc |
|---|---|---|---|---|
| **CLAIMED-DONE (fake green)** | **~30 (~70%)** | agent declared implemented/verified/green; verifier rejected — verified a weak proxy ("it runs / I wrote it"), not the real acceptance criterion | **#2 verify-before-finalize** (bigger ROI) | [02](02-verify-before-finalize-rfc.md) |
| **R-ENV install-refusal** | ~8-10 (~20-25%) | agent obeyed the SWE-bench "never install" core rule and bailed on tasks that REQUIRE install/build | **#1 env-posture** (clean, confirmed) | [01](01-env-posture-rfc.md) |
| hard ceiling (top-tier ≈0) | ~7-12 | genuinely beyond the model (gpt2-codegolf, protein-assembly, mteb-leaderboard, …) | none (model) | — |
| budget / other | ~5 | ran out of turns mid-build, or uncategorized | tune limits | — |

Classification is a heuristic on final-message text + solve-rate, NOT proof of mechanism — a few are
misfiled (e.g. `nginx-request-logging` reads R-ENV but a loose regex filed it under claimed-done;
`merge-diff-arc-agi` is model-reasoning, not verify). Per-task mechanism is confirmed where each RFC relies on it.

## The two levers

### #1 — Environment Posture ([01-env-posture-rfc.md](01-env-posture-rfc.md))
The default system prompt hard-codes SWE-bench's `[R-ENV] Do NOT install dependencies … your patch is the
deliverable, not a working env` into `CORE_RULES`, inherited by the Terminal brain. TB tasks whose deliverable
IS a working environment (install grpc, build, configure a server) fail because the agent correctly obeys R-ENV.
Fix: an `EnvironmentPosture` (frozen | owned) that selects the env-rule group **as prompt text only** (never
coupled to runtime enforcement); the TB brain runs `owned`. Competitor-grounded (Codex/Claude Code treat this as
runtime sandbox config, not a prompt commandment). Blast radius ~8-10 tasks; clean and confirmed.

### #2 — Verify-before-finalize ([02-verify-before-finalize-rfc.md](02-verify-before-finalize-rfc.md))
The DOMINANT failure: the agent stops at "I implemented it / it runs" and reports done, but never exercises the
deliverable against the task's real success criterion (path-tracing-reverse claimed green but never diffed its
output against `/app/mystery`). A naive "verify before submit" steer was **already tried and reverted** (n=1
net-negative — it made the agent over-persist on unsolvable tasks). This RFC is the *structural* version: a
pre-report gate that requires evidence of an end-to-end terminal exercise, bounded by a persistence budget, with
an honest verified-pass / verified-fail / unverifiable trichotomy — NOT a blanket "try harder" steer.

## Sequencing
- The two levers are **orthogonal** (one edits env-rule text, one adds a pre-report gate) — shippable in either
  order or in parallel worktrees.
- Both are measure-first: land default-OFF byte-identical, A/B on the install-heavy / fake-green failure subsets,
  keep only on a measured f2p gain. Confirm SWE-bench Verified unchanged as the integrity guard.
- Recommended order: **#1 first** (smaller, fully confirmed, lower risk), then **#2** (bigger ROI but must beat
  the prior reverted steer — higher design risk).

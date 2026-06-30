# Handoff — jun-29 agent-3 (SWE-bench multi-dataset platform + Pro measurement)

> Split-brain coordination doc. Scan §0 FIRST — there is a **live EC2 campaign** running.

## 0. 🔴 LIVE RIGHT NOW — do NOT disturb

**Pro-266 measurement campaign is RUNNING** (launched ~21:51, 12h cap).
- supervisor: `bash tools/pro-measure.sh` (PID ~54398) + child `grade --mode full ... --dataset pro-python-266.jsonl` (PID ~54429)
- on-demand box **i-0485f33d6b18ba0ad** is MINE (this campaign). `i-0cefd19fa27242cc5` is a pre-existing box (NOT mine — leftover from the user's oracle-pilot/breadth; left alone).
- logs: `/tmp/pro-measure-supervisor.log` + `/tmp/pro-measure-run.log`

**Rules for other agents:**
- ❌ Do NOT launch another `grade --mode full` / pool run on the **same OAuth (gpt-5.5)** — concurrent grading = 429 throttle kills BOTH (hard rule). Wait for this campaign or use a different account.
- ❌ Do NOT `pkill` broadly or `box rm` i-0485f33d — you'll kill the campaign.
- ✅ Check progress anytime (read-only): `bun run tools/pro-measure-report.ts ~/.quanta/bench/datasets/pro-python-266.jsonl`
- ✅ Safe to STOP: `pkill -f pro-measure.sh` then `pkill -f "grade.*pro-python"`. It's **resume-able** — relaunch `bash tools/pro-measure.sh` picks up where it left off (reports persist per-instance).
- Current number: **67% (Wilson 95% CI 21–94%, n=3 pilot)** — CI tightens as the 263 remaining grade.

## 1. What was DONE this session

**Multi-dataset platform (Verified/Pro/Live)** — RFC `docs/plans/jun-29-swe-benchmark-platform/README.md`. Verified byte-identical when unselected (R1). 3-round adversarial-audited. Family routing via `--dataset-family` / `QUANTA_SWEBENCH_DATASET_FAMILY` env.
- **Live**: SWE-bench-Live fork pip-spec + `starryzhang` image namespace, derived from `isLiveRun(name,family)` (ec2-lifecycle.ts). **Live 5 ran**: 1 resolved / 1 miss / 3 measurement-holes (report-i-03463…).
- **Pro**: ScaleAI harness verifier (`src/apps/bench/pro-swebench.ts`). Box-wiring: `setupProHarnessIfNeeded` clones `scaleapi/SWE-bench_Pro-os` + builds a venv. **Pro 5 ran**: 2 resolved / 3 miss, all measurable (report-i-07d0…).
- 🔴 **3 Pro runtime bugs found+fixed**: (a) preset LSP-gate refuses multilang → use `--preset agentless-v1`; (b) **CWD bug** — `swe_bench_pro_eval.py` reads `dockerfiles/{base,instance}_dockerfile/<id>/Dockerfile` RELATIVE, so verifier must `spawn(cwd=harnessDir)` not temp (was → 5/5 systematic gold-fail); (c) spot reclaim loses results → `QUANTA_FULL_REMOTE_ONDEMAND=1`.

**Solvability oracle**: `goldResolved?:boolean` per-instance (types/driver/report). gold-sanity on-fail already gives the full signal (pass=solvable / fail+gold-ok=genuine-miss / fail+gold-fail=verifier-broken=excluded). `QUANTA_SWEBENCH_GOLD_SANITY=always` = full audit.

**External baselines**: `tools/leaderboard-dashboard/external-baselines.ts` → `external-baselines.json` (Live leaderboard per-instance + Pro curated aggregate). Regen: `bun run tools/leaderboard-dashboard/gen-external-baselines.ts`.

**Dashboard**: family partition (`[pro]`/`[live]` campaign prefix, verified byte-identical), external-SOTA column, per-instance gold-broken⚠/ext✓ markers. + **management console** (🛠관리 tab): launch/running-now/console/box-stop. Control plane cleanly separable: `bench-actions.ts` (validated argv, security boundary) + `bench-control.ts` (spawn/registry service) + thin server.ts adapter. 3-round adversarial-audited (localhost-bind+loopback-gate, launch cap, flag-injection fence, log byte-cap, spawn timeout, read-route gating, tail-read, evict, file perms).

**SOTA++ Pro measurement harness (hellgate-built)**: `src/apps/bench/pro-measure.ts` (pure core — filterPythonPro / planResumeChunks / tallyMeasurement[solvability-gated + Wilson 95% CI] / vsExternalLine[population-honest]) + `tools/pro-measure-report.ts` (CLI) + `tools/pro-measure.sh` (campaign supervisor). 12 unit tests. Self-adversarial-audited (2 fixes: measurement-validity framing + mtime-sorted dedup).

**Pro problem-commentary**: `docs/analysis/swe-bench-pro-analysis/` README has a "우리 실측" section; ran instances annotated `> 우리 실측`.

## 2. Key files / commands

- Datasets: `~/.quanta/bench/datasets/{pro-5,live-5,pro-python-266}.jsonl`
- Tests (all green): `bun test tools/leaderboard-dashboard/ src/apps/bench/pro-measure.test.ts src/apps/bench/pro-swebench.test.ts src/runner/batch/eval/driver-infra-hole.test.ts`
- Reports land: `~/Library/quanta-codeagent-v3/bench/full-remote/report-i-*.json` (datasetFamily field distinguishes)
- Dashboard: `QUANTA_DASH_HOST=127.0.0.1 bun run tools/leaderboard-dashboard/server.ts` (loopback-only for the console)

## 3. NEXT / TODO

1. **Pro-266 campaign → real number** (in flight): let it grade; CI tightens. Re-run the report CLI for the headline.
2. **Gap#5 — multilang repro-rail** (RFC-scoped separate workstream): repro self-oracle is Python/pytest-only, so Pro JS/TS/go get no execution-feedback. NOTE: `docs/plans/jun-29-repro-adapter-polyglot/` exists untracked — **another agent may already be on this**; coordinate before duplicating.
3. **Console M2** (LOW, documented): launch registry is in-memory → a dashboard restart loses the launch→log-tail link (boxes still visible via box-status; runs survive). Not fixed — full registry persistence judged not worth the ROI.
4. **go/js Pro lanes**: our stack is weak there (no repro rail, semantica Go = DfgReady only). The Python-266 is the addressable subset measured now.

## 4. Landmines / lessons

- **OAuth throttle is the #1 killer** — never run concurrent grading on one account. Pilot/breadth/measure must serialize.
- **EC2 terminate is classifier-blocked** for the agent (shared infra). Boxes self-reap via `shutdown -h +180` TTL. Don't fight it; don't over-claim "orphan burning $" without checking state (I mis-diagnosed a *terminated spot* box as an on-demand orphan — `aws ec2 describe-instances` FIRST).
- **Plain `nohup &` / `setsid` long runs get REAPED (~15-20min) in this env** — use the harness `run_in_background` (turn-survives) or a self-heal supervisor.
- **Don't over-infer** — every "why did X fail" answer this session that wasn't grounded in ssh/log/source got corrected. Check the box / read the source.
- **Population honesty**: our Python-266 rate is NOT comparable to the published Pro-731 SOTA (different population). The report CLI flags this; keep it.
- **Verified byte-identical** is a hard invariant — every multi-dataset change is additive + family-gated.

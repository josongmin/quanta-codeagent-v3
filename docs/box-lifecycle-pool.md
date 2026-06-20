# Box-lifecycle pool — full-remote bench (jun-20)

Run SWE-bench patch-gen + grading on EC2 boxes, **paying the box bootstrap
(boot + rsync + bun install + swebench/uvx warm + pyright ~4min) ONCE** and
reusing the box across many slices — instead of re-bootstrapping every wave.

Boxes are **spot** (cheap, reclaimable; reclaim is handled by requeue). A box is
left **warm** after a run and self-terminates at its EC2 TTL (180min). The
binding throughput limit is the shared gpt-5.4 OAuth login rate, not box CPU —
so prefer **one box with high per-box concurrency** over many boxes.

> ⚠️ `--allow-remote-secrets` is required: the box runs the agent, so a
> short-lived OAuth access_token is shipped to it (refresh/id stripped, over ssh
> STDIN, IMDSv2 hop-1, TTL self-terminate). Never an agent tool — operator CLI only.

Code: [`src/apps/bench/remote/box-session.ts`](../src/apps/bench/remote/box-session.ts)
(provision/attach/grade), [`pool.ts`](../src/apps/bench/remote/pool.ts) (queue +
reuse + backoff), [`cli.ts`](../src/apps/bench/cli.ts) (`pool`/`box` subcommands),
[`_mclass-sweep/sweep.py`](../_mclass-sweep/sweep.py) (sweep integration).

---

## `bench box` — box lifecycle

```bash
# list running quanta-bench boxes (id / state / launch-time / ip / type)
bun run src/apps/bench/cli.ts box ls

# terminate one box, or ALL tagged boxes
bun run src/apps/bench/cli.ts box rm i-0abc123
bun run src/apps/bench/cli.ts box rm all

# pre-warm: provision + bootstrap ONE box and leave it alive for pool to reuse
bun run src/apps/bench/cli.ts box up            # spot
QUANTA_FULL_REMOTE_ONDEMAND=1 bun run src/apps/bench/cli.ts box up   # on-demand (no reclaim)
```

> When other runs are in flight, ALWAYS `box ls` first and `rm` only your own
> instance ids. Never blind-`rm all` — it kills everyone's boxes.

## `bench pool` — many slices, one (reused) box

```bash
# grade several slice jsonls; reuses a warm idle box if one exists, else launches
QUANTA_FULL_REMOTE_CONCURRENCY=8 \
  bun run src/apps/bench/cli.ts pool --allow-remote-secrets \
  --datasets slice1.jsonl,slice2.jsonl,slice3.jsonl

# plan only — prints chunks + box dirs, launches nothing
bun run src/apps/bench/cli.ts pool --allow-remote-secrets \
  --datasets a.jsonl,b.jsonl --dry-run
```

Options: `--workers N` (boxes, default 1 — N also multiplies the 429 burst),
`--model gpt-5.4`, `--preset agentless-v2`, `--max-box-wall-min 150` (rotate the
box before its TTL kills a chunk), `--keep` (don't auto-terminate dead boxes).

Behaviour:
- **reuse** — attaches to a running, bootstrapped, **idle** box (no `cli.ts run` /
  `run_evaluation` process) → skips bootstrap. Busy boxes are skipped (attaching
  to a mid-grade box would false-negative correct patches).
- **warm** — a healthy box is left alive at drain for the next run (TTL reaps it).
- **runId-scoped** — each chunk writes to `~/runs/<runId>/` on the box, so chunks
  never collide; local artifacts saved as `report-<runId>.json` under benchHome.
- **fresh token per chunk** — re-reads chatgpt.json each chunk (no stale token).
- **box-death requeue** — a chunk whose box died (spot reclaim) is retried on a
  fresh box (bounded), surfaced as `lost` only if it never grades.
- **429 backoff** — a chunk hitting the shared-OAuth rate limit (generation_error
  / 429 in its run log) pauses before the next chunk: 90s → 180s → … (cap 30min),
  reset by a clean chunk.

Key env: `QUANTA_BENCH_AUTH_FILE` (point a 2nd ChatGPT account here to decouple
rate limits — default `~/.quanta/auth/chatgpt.json`),
`QUANTA_FULL_REMOTE_CONCURRENCY` (per-box patch-gen, default 6, clamp 1–16),
`QUANTA_FULL_REMOTE_ONDEMAND=1` (spot → on-demand),
`QUANTA_FULL_REMOTE_AMI` / `--ami` (override the prebaked AMI).

## sweep — pool by default

```bash
python3 _mclass-sweep/sweep.py              # SWEEP_USE_POOL=1 (default): super-wave → pool
SWEEP_USE_POOL=0 python3 _mclass-sweep/sweep.py   # fall back to per-slice grade --mode full
```

Tuning: `SWEEP_POOL_CHUNKS=2` (slices per super-wave on one box — keep
`CHUNKS × SLICE` under the TTL), `SWEEP_POOL_WORKERS=1`, `SWEEP_POOL_TIMEOUT=9000`
(150min box-life wall). The per-box concurrency is pinned to 8 in `run_pool`.

---

## Typical workflow

```bash
# 1) pre-warm one box while the fleet is quiet
bun run src/apps/bench/cli.ts box up
bun run src/apps/bench/cli.ts box ls          # note the iid

# 2) reuse it (bootstrap skipped — grading starts immediately)
QUANTA_FULL_REMOTE_CONCURRENCY=8 \
  bun run src/apps/bench/cli.ts pool --allow-remote-secrets --datasets s1.jsonl,s2.jsonl

# 3) clean up your boxes when done
bun run src/apps/bench/cli.ts box ls
bun run src/apps/bench/cli.ts box rm i-<your-iid>
```

## Notes / caveats

- For **fat slices** (SLICE≈16) bootstrap (~4min) is small vs grading (~90min), so
  the reuse win is modest — the big throughput win came from the P0 config
  (1 box / SLICE 16 / concurrency 8 / spot). Reuse matters most for small,
  high-frequency slices and back-to-back runs.
- Grading stays **serial per box** (a process-global docker mutex) — concurrent
  on-box grading false-negatives correct patches. Patch-gen stays concurrent.
- There is **no cross-run global concurrency cap**: if you run several pools /
  `grade --mode full` at once they share the OAuth token and can 429 each other.
  The pool's 429 backoff is per-run only. Keep total in-flight patch-gen modest.
- Live end-to-end (one box → multiple chunks → terminate) is proven by the
  offline hellgate suite; validate on real hardware when the fleet is idle.
```


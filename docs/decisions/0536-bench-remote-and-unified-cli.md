# ADR-0536 — Unified `quanta-bench` CLI + remote grading (sb-cli / SSH / AWS) + analysis layer

- Status: **P0 implemented** (2026-06-15) — `src/apps/bench/cli.ts` (run/grade/diff/explain/leaderboard/presets) + `remote/` (ssh + ec2 backends) + `analyze/` (verdicts/diff/explain/leaderboard). 51 unit tests (cli 8 + remote 22 + analyze 21). `package.json` `bench` → `cli.ts`. P1/P2/P3 pending.
- Date: 2026-06-15
- Supersedes/relates: bench harness (`src/apps/bench`), ADR-0014 (local validator), jun-15 preset unification

## Context

SWE-bench Verified = 500 instances. On this arm64 Mac, grading runs x86 images under
emulation (`max_workers=1`, ~7.5 min/instance) → **~60h grading alone**, plus patch-gen,
GB image re-pulls (`cache_level=env` evicts), and `retry=3`. Full run ≈ **2–4 days**,
not practical locally. Two structural gaps:

1. **No remote execution** — no sb-cli, no cloud runner, no SSH dispatch in the codebase.
2. **No cross-run analysis** — each run writes its own `report.json`; no A/B diff, no
   cost/token aggregation, no automated agent-vs-gold failure analysis, no leaderboard
   automation. The bench CLI is flat-flag (`bun run src/apps/bench/index.ts --swebench …`),
   no subcommands.

User intent: run remotely (incl. **AWS provisioning**) and extract the info needed, all
under **one unified CLI**.

## Key insight — split the two phases

SWE-bench is two phases with different bottlenecks:

- **patch-gen** — LLM-bound (network). Instance-independent ⇒ fully parallel. Runs
  *anywhere*, including the local Mac. Produces `predictions.jsonl`.
- **grading** — Docker/x86-bound. A stateless function `predictions.jsonl → report.json`.
  THIS is the only part that needs x86 + parallelism.

⇒ "Remote" means **remote grading**. patch-gen stays local (or wherever). This also means
the grading box **never sees an LLM key** (patches already exist) — a security win.

## Decision

### 1. Unified CLI — `quanta-bench <subcommand>`

New `src/apps/bench/cli.ts` dispatches on `argv[2]`, wraps the existing `runMain` for
`run`, routes legacy flat flags (`--swebench` present, no subcommand) to `run` for
back-compat. `package.json`: `"bench": "bun run src/apps/bench/cli.ts"`.

```
quanta-bench run       --dataset picks-3 --preset agentless-v1 --model gpt-5.4   # local (current)
                       [--patch-backend local|ssh:…|ec2] [--grade-backend local|sb-cli|ssh:…|ec2]
quanta-bench grade     --predictions p.jsonl --backend <sb-cli|ssh|ec2>          # grade existing patches
quanta-bench remote    --dataset verified --preset agentless-v1 --backend ec2    # default: local patch-gen + remote grade
                       [--mode grade-only|full] [--allow-remote-secrets]
quanta-bench diff      <runA> <runB>                                             # A/B / regression
quanta-bench explain   <run> <instance>                                          # agent-vs-gold + FAIL_TO_PASS
quanta-bench cost      <run>                                                     # tokens / $ / wall-clock
quanta-bench leaderboard add <run> | show
quanta-bench presets
```

**Two independent backends.** `run` takes a `--patch-backend` (where patch-gen runs) and a
`--grade-backend` (where grading runs); each is `local | ssh:<host> | ec2` (grade also
`sb-cli`). `remote` is sugar over `run`:

- `remote --mode grade-only` (default) ≡ `run --patch-backend local --grade-backend <backend>`
- `remote --mode full` ≡ `run --patch-backend <backend> --grade-backend <same>`

`grade-only` is the **secure default** (no LLM key leaves the local box). `full` runs patch
generation AND grading on the remote runner — it is **opt-in only** and requires
`--allow-remote-secrets` (see §6 for why the bar is higher).

### 2. Grading backends — pluggable `GradeBackend`

Interface: `grade(predictionsPath, instanceIds, opts) → reportPath`. No new npm deps —
shell out to system `aws`/`ssh`/`rsync`/`sb-cli` (respects the user's existing config,
SSO, ssh-agent).

| backend | infra | speed | when |
|---|---|---|---|
| `sb-cli` (**probed 2026-06-15 — NOT viable on free tier**) | none — HTTP to api.swebench.com | n/a | see note below |
| **`ssh:<host>`** (**now P0**) | BYO x86 box (one) | native, `max_workers=N` | the real zero-to-grading path; no per-run provisioning |
| `ec2` / `modal` (**P1/P2**) | autoscaled | fan-out, minutes | full 500 at scale, repeated runs |

> **sb-cli probe result (2026-06-15).** sb-cli is real and accepts submissions, BUT a free
> key (generated via `gen-api-key`/`verify-api-key`) **produces no verdicts** — every eval
> RUN fails (`Failed runs: 1`, no reason exposed), confirmed across **verified AND lite**,
> with **both our patches AND the official GOLD patch**. `get-quotas` lists only
> `swe-bench_lite` + `swe-bench-m` (no `verified`), but even lite-gold fails. ⇒ the free tier
> does not grade for us (tier limitation or undocumented submission requirement we could not
> resolve in-band). **sb-cli is parked**; revisit only if a working authorization/tier is
> obtained. The viable remote path is self-host (`ssh`/`ec2`).

### 3. Remote-access layer (SSH backend)

- **Connection**: system `ssh`/`rsync` (zero deps, uses `~/.ssh` + ssh-agent).
- **Box modes**: (a) **BYO** `--host user@ip`; (b) **managed** `--provision` (§4).
- **Bootstrap** (idempotent): rsync `remote-bootstrap.sh`, run once — verify Docker daemon,
  `uvx --from swebench` warm, upload `instances.jsonl` if absent (cached across runs).
- **Transport**: rsync `predictions.jsonl` up (dataset cached on box); rsync
  `report.json` + `observe/` down. S3 staging optional for large fan-outs (§4).
- **Execution**: `ssh box "nohup python -m swebench.harness.run_evaluation
  --predictions_path … --max_workers N --namespace none …"` — x86 native ⇒
  `namespace none` (local build, NO emulation) ⇒ ~30s/instance vs 7.5min emulated.
  `nohup`/tmux so the run survives a dropped laptop connection.
- **Lifecycle/resume**: per-run `run-<id>/` on the box; reconnect+`tail` on disconnect;
  `report.json` retrieval = done signal; resume skips already-graded instances.
- **Secrets**: box gets **no LLM key** (grading-only). Cloud creds stay local
  (provision-only, never shipped).

### 4. AWS provisioning plan (`ec2` backend)

Orchestrated from the CLI by shelling to the user's `aws` CLI (no `@aws-sdk` dep; uses
their profile/SSO). Provision → bootstrap → grade → retrieve → terminate.

**Instance**: `c7i` family (Intel x86, **native amd64** ⇒ no emulation). Default
`c7i.8xlarge` (32 vCPU / 64 GB) → `max_workers≈24`. Grading is CPU+disk heavy (build/run
per-instance test containers).

**Storage**: `gp3` EBS 500 GB–1 TB root (full Verified image+repo set is tens of GB→100 GB+).

**AMI strategy**: P1 = stock Ubuntu 22.04 + bootstrap script (Docker, uvx, swebench) — zero
AMI upkeep, ~2–3 min first-boot. P2 = Packer-baked AMI with Docker + swebench + prewarmed
SWE-bench base/env images → spin-up in seconds, no per-run pulls.

**Spot vs on-demand**: grading is resumable (skip-done) ⇒ **spot** (~70% off) with
on-demand fallback. `c7i.8xlarge` ≈ $1.43/hr on-demand, ~$0.45/hr spot.

**Security group**: inbound `:22` from the user's current IP only; outbound open (Docker
Hub pulls + git clone of target repos). No other inbound.

**IAM**: the box needs ~nothing AWS-side (rsync transport). If S3 staging is used: a minimal
instance role with `s3:GetObject/PutObject` on one run-scoped prefix. Provisioning creds
are the user's local profile.

**Teardown / runaway guard**: terminate on success; `--keep` to retain. Always set a
**max-TTL self-terminate** (cloud-init `shutdown -h +<hours>` + `InstanceInitiatedShutdownBehavior=terminate`)
so a hung run can't bleed cost.

**Fan-out (P2)**: shard the 500 across K boxes (e.g. 5 × `c7i.4xlarge`, 100 each), grade in
parallel, merge shard reports → one `report.json`. CLI spawns K, dispatches shards, gathers,
terminates. Near-linear speedup; full Verified in ~1 hr, ~$5–15 total (spot).

**Provisioning flow** (CLI, local):
1. `aws ec2 run-instances` (spot, AMI, SG, key-pair, user-data=bootstrap) × shards
2. poll until SSH reachable → rsync predictions shard + dataset (or S3 stage)
3. `ssh nohup run_evaluation --max_workers N`
4. poll/tail → on done, rsync `report.json`+`observe/` back (or S3 fetch)
5. merge shard reports → unified report + `leaderboard add`
6. `aws ec2 terminate-instances` (+ TTL alarm safety)

### 6. Full remote mode (`--mode full`, opt-in)

Runs BOTH phases on the remote runner — for long runs you want fully detached from the
laptop (network/CPU/sleep-independent).

**Execution topology**

```
grade-only (default):  local[patch-gen → predictions.jsonl] ── rsync/S3 ──▶ remote[Docker grading → report.json]
full       (opt-in):   remote[patch-gen → predictions.jsonl → Docker grading → report.json]   (laptop detached)
```

**Remote runner needs** (full only): repo checkout + Bun/Python/Docker toolchain + model
provider access + preset/config + dataset + writable `runs/<run_id>/`. Required artifacts
retrieved: `runs/<run_id>/{manifest.json, predictions.jsonl, report.json, observe/, logs/}`.

**Reproducibility**: `manifest.json` pins toolchain + inputs (Bun version, `swebench`
version, dataset sha256, preset name, model id, git commit) so a full-remote run is
reproducible and auditable.

**Why the bar is higher — agent RCE on a secret-bearing box.** In full mode the remote box
runs the AGENT, and the agent executes model-generated shell/edits. So the box that now
holds the LLM key (and sits next to the cloud metadata endpoint) is also running
semi-untrusted code. Blast radius ≫ grade-only. Hardening is therefore mandatory, not
advisory:

- **Ephemeral, scoped, budgeted credentials** — prefer a per-run minted API key with a hard
  spend cap over shipping a long-lived key. NEVER ship the on-disk `chatgpt-oauth` token.
- **IMDSv2 enforced + hop limit 1** (`--metadata-options HttpTokens=required,HttpPutResponseHopLimit=1`)
  so the agent can't pivot through `169.254.169.254` to steal the instance-role creds.
- **No inbound SSH — use SSM Session Manager** for full mode (security group has zero inbound).
  Secrets injected at runtime from **Secrets Manager / SSM Parameter Store**, never EC2
  user-data (user-data is readable via IMDS by anything on the box).
- **Secrets never touch disk** — pass via process env / `tmpfs` (`/dev/shm`), not a rsync'd
  `.env`; exclude `.env`/secrets from all rsync artifacts; `set +o history`.
- **Redact secrets from `observe/` trajectories** before retrieval — the agent's tool
  outputs / env dumps could otherwise leak the key into the `.jsonl` we rsync back.
- **Mandatory TTL self-terminate** (§4) + **per-run token/$ budget cap** enforced on the box.
- **Egress restriction** where feasible (model provider + Docker Hub + git only).

**Secret-passing surface (full only)**: `--secret-env OPENAI_API_KEY` / `--env-file
.bench.remote.env`, gated behind `--allow-remote-secrets`. Rules: not written to
`manifest.json`, not echoed to logs, excluded from artifacts, SSM/Secrets-Manager on EC2.

### 5. Analysis layer — `src/apps/bench/analyze/` (pure, no Docker, hellgate-testable)

- `diffRuns(a,b)` → `{ newlyResolved, newlyBroken, common, deltaPct }` (preset A/B, regression)
- `explainFailure(run,inst)` → load agent patch (`observe/*.patch`) + gold `patch` +
  `test_patch` + `FAIL_TO_PASS` from the dataset → side-by-side render. Automates the
  manual pylint-8898 analysis.
- `costSummary(run)` → `observe` usage (tokens) + timestamps (wall-clock) → per-instance
  + aggregate $ (fills the gap where `report.json` omits token/cost).
- `leaderboardUpdate(runs[])` → merge resolved-sets across runs into
  `docs/swebench-leaderboard.md` (dedup best), replacing today's manual edits.

## Phasing

- **P0** (revised after the sb-cli probe): `cli.ts` subcommand skeleton + **`grade --backend
  ssh:<host>`** (self-host one BYO x86 box) + analyze `diff`/`explain`/`leaderboard`. ⇒
  native-speed Verified grading on a box you rent once; patch-gen local in parallel.
  (Original "P0 = sb-cli zero-infra" is **dropped** — the free tier produces no verdicts;
  see §2 note.)
- **P1**: `ec2` provisioning (§4, single box) + `cost` aggregation + parallel patch-gen knob.
- **P2**: `ec2`/`modal` autoscale — spot, baked AMI, K-way fan-out, TTL guard.
- **P3**: `--mode full` (remote patch-gen + grading, §6) — gated behind the full hardening
  set (ephemeral key + IMDSv2/hop-1 + SSM + observe redaction + TTL + budget cap).

## Alternatives considered

- **Full remote as the DEFAULT** — rejected: ships LLM keys to a box running semi-untrusted
  agent code, no benefit for the common case (patch-gen is network-bound, parallelizes fine
  locally). Full remote is instead an **opt-in mode** (§6, P3) for detached long runs, with
  mandatory hardening; the default stays `grade-only`.
- **`@aws-sdk` / `ssh2` npm deps** — rejected: shelling to the user's `aws`/`ssh` CLIs is
  dependency-free and inherits their auth (SSO, ssh-agent, MFA) for free.
- **sb-cli only (skip self-host)** — insufficient for privacy-sensitive corpora / when the
  hosted quota is exhausted; SSH/EC2 remain the escape hatch.

## Consequences

- One CLI surface for local/remote/analysis (`run` with `--patch-backend`/`--grade-backend`;
  `remote` as sugar); legacy flat flags keep working.
- Default grading is LLM-key-free (security) and resumable (cost-safe).
- P0 alone makes full Verified practical (hosted grading + local parallel patch-gen).
- Full remote (P3) raises the operational/security bar (agent RCE on a secret-bearing box) —
  it is opt-in, hardened, and never the default.
- New maintenance: backend adapters + (P2) an AWS provisioning path that MUST carry the
  TTL self-terminate guard (runaway-cost backstop) + (P3) the full-mode secret/RCE hardening.

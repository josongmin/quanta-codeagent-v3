# SWE-bench grading on EC2 — runbook (account 527687867704, ap-northeast-2)

Self-host grading box. Patch-gen stays local (Mac), only **grading** runs on x86 EC2
(native amd64 ⇒ no emulation ⇒ ~30s–2min/instance vs 7.5min emulated). Probed values below
are real for this account (2026-06-15).

## Grounded parameters

| thing | value | note |
|---|---|---|
| region | `ap-northeast-2` | Seoul |
| AMI | `ami-0afe1fd15675c3f15` | Ubuntu 22.04 amd64 (Canonical) |
| instance | `c7i.8xlarge` | 32 vCPU / 64 GB, native amd64 |
| spot price | ~$0.30/hr | vs ~$1.43 on-demand (79%↓) |
| key pair | `pickinstead_korea.pem` | KeyName as registered; need matching private key locally to SSH |
| VPC / subnet | `vpc-4340a92a` / `subnet-9c13f1e7` (az 2b) | default |
| quota | Spot 512 vCPU, OnDemand 1920 | ample (fan-out up to 16 boxes) |
| disk | gp3 600 GB | SWE-bench image set is large |

## Cost

One c7i.8xlarge spot ≈ **$0.30/hr**. Full Verified grading (pull prebuilt images +
`max_workers≈24`) ≈ a few hours first run → **~$1–3 total**. TTL self-terminate caps runaway.

---

## Stage 0 — security group (once)

```bash
R=ap-northeast-2
MYIP=$(curl -s ifconfig.me)
SG=$(aws ec2 create-security-group --region $R --group-name quanta-bench-sg \
  --description "quanta bench grading box" --vpc-id vpc-4340a92a \
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region $R --group-id $SG \
  --protocol tcp --port 22 --cidr ${MYIP}/32          # SSH from my IP only
echo "SG=$SG"
```

## Stage 1 — launch spot box (bootstrap via user-data, IMDSv2, TTL guard)

`user-data.sh` (installs Docker + uvx + swebench, self-terminates after 6h as a backstop):

```bash
cat > /tmp/user-data.sh <<'EOF'
#!/bin/bash
set -eux
# runaway-cost backstop: self-terminate in 6h regardless
shutdown -h +360
# Docker
apt-get update -y && apt-get install -y docker.io git python3-pip
systemctl enable --now docker
usermod -aG docker ubuntu
# uv / uvx (for the swebench harness, isolated)
su - ubuntu -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
EOF

R=ap-northeast-2
IID=$(aws ec2 run-instances --region $R \
  --image-id ami-0afe1fd15675c3f15 \
  --instance-type c7i.8xlarge \
  --key-name pickinstead_korea.pem \
  --subnet-id subnet-9c13f1e7 \
  --security-group-ids $SG \
  --instance-market-options '{"MarketType":"spot"}' \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1' \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":600,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --user-data file:///tmp/user-data.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=quanta-bench}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "IID=$IID"
aws ec2 wait instance-running --region $R --instance-ids $IID
HOST=$(aws ec2 describe-instances --region $R --instance-ids $IID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "HOST=$HOST"
```

`--instance-initiated-shutdown-behavior terminate` + `shutdown -h +360` ⇒ the box **deletes
itself** after 6h if anything hangs. `HttpTokens=required` + `HopLimit=1` = IMDSv2 enforced
(no metadata-credential theft).

## Stage 2 — wait for bootstrap, sanity

```bash
KEY=~/.ssh/pickinstead_korea.pem        # adjust to where your private key lives
ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$HOST \
  'cloud-init status --wait; docker run --rm hello-world >/dev/null && echo DOCKER_OK; ~/.local/bin/uvx --from swebench --python 3.11 python -c "import swebench;print(swebench.__version__)"'
```

## Stage 3 — upload predictions + dataset

```bash
# predictions from a local patch-gen run (e.g. picks-10 or full verified)
scp -i $KEY /tmp/bench-picks3/preds.jsonl ubuntu@$HOST:~/preds.jsonl
scp -i $KEY /Users/songmin/Documents/code-new/quanta-benchmark-corpus/external/swebench/verified/raw/instances.jsonl ubuntu@$HOST:~/instances.jsonl
```

## Stage 4 — grade (native amd64, prebuilt pull, parallel)

```bash
ssh -i $KEY ubuntu@$HOST bash -s <<'EOF'
set -eux
~/.local/bin/uvx --from swebench --python 3.11 python -m swebench.harness.run_evaluation \
  --predictions_path ~/preds.jsonl \
  --run_id quanta-ec2 \
  --max_workers 24 \
  --cache_level instance \
  --namespace swebench \
  --dataset_name ~/instances.jsonl \
  > ~/grade.log 2>&1 &
echo "grading started (nohup); tail ~/grade.log"
EOF
```

`--namespace swebench` = pull prebuilt amd64 images (no local build wait); native ⇒ runs
without emulation. `--cache_level instance` keeps images warm across instances. Survives a
dropped laptop (background + ssh re-attach).

## Stage 5 — retrieve report + terminate

```bash
ssh -i $KEY ubuntu@$HOST 'cat ~/quanta-ec2.*.json' > /tmp/ec2-report.json   # harness writes <model>.<run_id>.json
scp -i $KEY ubuntu@$HOST:'~/logs/**' /tmp/ec2-logs/ 2>/dev/null || true
aws ec2 terminate-instances --region ap-northeast-2 --instance-ids $IID       # or rely on the 6h TTL
```

---

## Where the CLI backend plugs in (ADR-0536 P0/P1)

The above is the manual runbook. `quanta-bench grade --backend ec2` (ADR-0536) automates
exactly these stages: create-SG → run-instances(spot) → wait → scp preds → ssh
run_evaluation → scp report → terminate. The `ssh:<host>` backend skips stages 0–2 (BYO box).

## Troubleshooting *why* an instance fails (without re-paying)

Don't re-run the whole pipeline on every fix. **Trajectory cassette**:
`QUANTA_BENCH_RECORD_TRAJECTORY=1` records the agent's full LLM stream once
(full-remote fetches it as `trajectory-<suffix>.jsonl`); `QUANTA_BENCH_REPLAY_TRAJECTORY=<file>`
replays it for **zero tokens** while you change deterministic code (oracle/selection).

Start from `closure-<suffix>.json` → `synth_repro_base_red_rate` (0 ⇒ oracle never
established = the usual bottleneck) and `report-<suffix>.json` →
`perInstance[].reproTest.reason`. For a deterministic build-env failure, the cheapest
repro is to check out the repo at `base_commit` and run `uv run` (the `reproRunArgv`
argv) directly — no LLM, no cassette.

## Live trace — watch one run's spans (run-id deep-link, ADR-0268)

Stream the agent loop's spans (LLM requests, tool calls, durations, prompt/response
payloads) to a local waterfall UI, and jump straight to **one** run even when many
stream into the same sink (e.g. an A/B fan-out).

```bash
# 1. start the receiver + UI (stays up; Ctrl-C to stop). Opens http://127.0.0.1:4318/
quanta-bench trace

# 2. run the bench pointed at it. A run id is AUTO-ISSUED (no manual step) and the
#    boot log prints the deep-link. For a clean arm label, set it yourself:
QUANTA_OTEL_ENDPOINT=http://127.0.0.1:4318 \
QUANTA_OTEL_RUN_ID=closure-repair-A2 \      # optional — auto = <preset>-<base36 time>
  quanta-bench run --swebench tasks.jsonl …
# → logs:  [otel] run closure-repair-A2 live trace → http://127.0.0.1:4318/?run=closure-repair-A2

# 3. open ONE run's spans (sink already running — link-only, no new receiver):
quanta-bench trace-url closure-repair-A2
```

- **`quanta-bench trace [<run-id>]`** — launch the receiver + UI; with a run-id it deep-links.
- **`quanta-bench trace-url <run-id>`** — open/print the deep-link against an already-running sink.
- The viewer's `?run=<id>` shows only that run; a chip in the header clears the filter.
- **Full-remote**: `QUANTA_OTEL_ENDPOINT` is forwarded to the box and the box's spans
  ride a reverse SSH tunnel back to your sink. The auto-issued run-id is forwarded too,
  so **all boxes of one invocation share one run-id** (one operator run = one link).
- **Default-OFF**: with no `QUANTA_OTEL_ENDPOINT` set, nothing streams and no run-id is
  issued — byte-identical to a plain run.

## Gotchas (this account/region)

- `key-name` is literally `pickinstead_korea.pem` (registered with the `.pem` suffix) — you
  must hold the matching private key file locally for SSH/scp.
- Spot can be reclaimed; grading is resumable (re-run skips graded instance ids).
- First run pulls every image once (GB each) — slow start, then fast. `cache_level=instance`
  + 600 GB disk keeps them.
- Always confirm the box terminated (`aws ec2 describe-instances ... Name=tag:Name,Values=quanta-bench`)
  — the 6h TTL is a backstop, not a substitute for explicit terminate.

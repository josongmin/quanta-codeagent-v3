#!/usr/bin/env bash
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
LOG=.tmp/rerun-throttle-26/run.log
WLOG=.tmp/rerun-throttle-26/watch.log
echo "[watch] start $(date -u +%H:%M:%SZ) — waiting for user A/B boxes to drain" >> "$WLOG"
while true; do
  N=$(aws ec2 describe-instances --region ap-northeast-2 \
      --filters "Name=instance-state-name,Values=running,pending" \
                "Name=tag:Name,Values=quanta-bench-full" \
      --query "length(Reservations[].Instances[])" --output text 2>>"$WLOG")
  echo "[watch] $(date -u +%H:%M:%SZ) live quanta-bench-full boxes: $N" >> "$WLOG"
  if [ "$N" = "0" ]; then
    echo "[watch] boxes idle — launching rerun $(date -u +%H:%M:%SZ)" >> "$WLOG"
    QUANTA_BENCH_PRESET=agentless-v3-thin-strict \
    QUANTA_FULL_REMOTE_CONCURRENCY=3 \
    bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
      --dataset .tmp/rerun-throttle-26.jsonl >> "$LOG" 2>&1
    echo "[watch] rerun process exited $(date -u +%H:%M:%SZ)" >> "$WLOG"
    break
  fi
  sleep 60
done

#!/usr/bin/env bash
# jun-27 closure-repair A/B — CONCURRENT by arm (3 boxes, one per arm) on the fresh
# account (proven: 55-turn solves, gpt-5.5 streams fine). ~3x faster than serial;
# A2-A1 (reinject loop) and A1-A0 (grounding) land together.
#   --allow-extra-boxes bypasses the single-box grade lock so 3 grades run at once.
#   ONE shared trace sink (durable file) is started first; setting QUANTA_OTEL_
#   ENDPOINT makes each arm REUSE it (no per-arm embed race) so all 3 arms' boxes
#   tunnel their spans into one capture. watchdog ON (30min idle abort).
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
DS="$HOME/.quanta-ab-dataset.jsonl"
[ -s "$DS" ] || { echo "FATAL: dataset missing"; exit 1; }

export QUANTA_FULL_REMOTE_ONDEMAND=1
export QUANTA_FULL_REMOTE_INSTANCE_TYPE=c7i.4xlarge
export QUANTA_FULL_REMOTE_CONCURRENCY=4   # 4 cases/box in parallel (3 boxes ⇒ ≤12 streams)
export QUANTA_BENCH_NO_PROGRESS_ABORT_S=1800

SUP="$HOME/.quanta-ab6-supervisor.log"
echo "[$(date +%H:%M:%S)] concurrent A/B START (3 boxes, gpt-5.5, watchdog=1800s)" > "$SUP"

# ONE shared trace sink (durable) — arms point at it instead of each embedding one.
nohup bun run src/apps/bench/cli.ts trace --save "$HOME/.quanta-ab6-traces.jsonl" --no-open \
  > "$HOME/.quanta-ab6-sink.log" 2>&1 &
SINK_PID=$!
sleep 4
export QUANTA_OTEL_ENDPOINT="http://127.0.0.1:4318"   # arms reuse the shared sink
echo "[$(date +%H:%M:%S)] shared trace sink PID $SINK_PID → ~/.quanta-ab6-traces.jsonl" >> "$SUP"

run_arm() {
  local tag="$1" preset="$2"
  QUANTA_BENCH_PRESET="$preset" QUANTA_OTEL_RUN_ID="$tag" nohup bun run src/apps/bench/cli.ts \
    grade --mode full --allow-remote-secrets --allow-extra-boxes \
    --dataset "$DS" --preset "$preset" --model gpt-5.5 \
    > "$HOME/.quanta-ab6-$tag.log" 2>&1 &
  echo "[$(date +%H:%M:%S)] $tag ($preset) PID $!" >> "$SUP"
}

run_arm A0 agentless-v6-singlepass-execfull
run_arm A1 agentless-v6-closure-control
run_arm A2 agentless-v6-closure-repair
echo "[$(date +%H:%M:%S)] 3 arms launched concurrent" >> "$SUP"

wait                       # block until all 3 arms finish
kill "$SINK_PID" 2>/dev/null
echo "[$(date +%H:%M:%S)] === ALL ARMS DONE; sink stopped ===" >> "$SUP"

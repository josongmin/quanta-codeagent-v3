#!/usr/bin/env bash
# jun-27 closure-repair A/B — SERIAL re-run after the 3-box concurrent run wedged
# (all 3 arms froze ~2min in = account throttle under 3 concurrent patch-gen
# streams). One box at a time (1/3 the account load) + the no-progress watchdog ON
# (a wedged box self-aborts after 30min idle and requeues on a fresh box, instead
# of burning hours). on-demand (no spot reclaim) + DURABLE logs under $HOME.
#   A2 - A1 = the reinject loop ALONE | A1 - A0 = the closure grounding.
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
DS="$HOME/.quanta-ab-dataset.jsonl"
[ -s "$DS" ] || { echo "FATAL: dataset $DS missing"; exit 1; }

export QUANTA_FULL_REMOTE_ONDEMAND=1
export QUANTA_FULL_REMOTE_INSTANCE_TYPE=c7i.4xlarge
export QUANTA_FULL_REMOTE_CONCURRENCY=1
export QUANTA_BENCH_NO_PROGRESS_ABORT_S=1800   # #2 watchdog: abort a 30min-idle box

SUP="$HOME/.quanta-ab5-supervisor.log"
echo "[$(date +%H:%M:%S)] serial A/B START (watchdog=1800s, on-demand, 1 box)" > "$SUP"

run_arm() {
  local tag="$1" preset="$2"
  echo "[$(date +%H:%M:%S)] === ARM $tag ($preset) START ===" >> "$SUP"
  QUANTA_BENCH_PRESET="$preset" bun run src/apps/bench/cli.ts grade --mode full \
    --allow-remote-secrets --dataset "$DS" --preset "$preset" --model gpt-5.5 \
    > "$HOME/.quanta-ab5-$tag.log" 2>&1
  echo "[$(date +%H:%M:%S)] === ARM $tag DONE (exit $?) ===" >> "$SUP"
}

run_arm A0 agentless-v6-singlepass-execfull
run_arm A1 agentless-v6-closure-control
run_arm A2 agentless-v6-closure-repair
echo "[$(date +%H:%M:%S)] === ALL 3 ARMS DONE ===" >> "$SUP"

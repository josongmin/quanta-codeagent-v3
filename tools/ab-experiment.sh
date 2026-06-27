#!/usr/bin/env bash
# jun-27 closure-repair A/B — isolates the repro-gated REINJECT loop.
#   A0 agentless-v6-singlepass-execfull  (current winner; reinject OFF, no grounding)
#   A1 agentless-v6-closure-control      (v6 + closure grounding; reinject OFF)
#   A2 agentless-v6-closure-repair       (== A1 + closure-repair:5 rounds ON)
# Attribution:  A2 − A1 = the reinject loop ALONE   |   A1 − A0 = the grounding.
# on-demand (NO spot reclaim) + fresh token + DURABLE logs under $HOME (not /tmp,
# which gets reaped). Each arm = 1 box, patch-gen concurrency 1, grading SERIAL.
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
DS="$HOME/.quanta-ab-dataset.jsonl"
[ -s "$DS" ] || { echo "FATAL: dataset $DS missing/empty"; exit 1; }

export QUANTA_FULL_REMOTE_ONDEMAND=1          # no spot reclaim (the run-1 killer)
export QUANTA_FULL_REMOTE_INSTANCE_TYPE=c7i.4xlarge
export QUANTA_FULL_REMOTE_CONCURRENCY=1        # 1 patch-gen per box

run_arm() {
  local tag="$1" preset="$2"
  QUANTA_BENCH_PRESET="$preset" \
    nohup bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
    --dataset "$DS" --preset "$preset" \
    > "$HOME/.quanta-ab4-$tag.log" 2>&1 &
  echo "$tag ($preset) → PID $! → ~/.quanta-ab4-$tag.log"
}

run_arm A0 agentless-v6-singlepass-execfull
run_arm A1 agentless-v6-closure-control
run_arm A2 agentless-v6-closure-repair
echo "launched 3 arms (on-demand, 20 cases each, fresh token)"

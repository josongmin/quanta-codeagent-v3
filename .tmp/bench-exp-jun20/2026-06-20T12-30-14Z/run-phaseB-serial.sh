#!/bin/zsh
# Phase B selector-stress, 3 arms SERIAL on the single token (throttle-safe).
# Waits for exp-a-v2 to finish first, then runs each arm to completion in turn.
set -o pipefail
ROOT=/Users/songmin/quanta-codeagent-v3
OUT="${0:A:h}"
DS="$OUT/02-selector-stress.jsonl"
AF="$HOME/.quanta/auth/chatgpt.json"
LOG="$OUT/phaseB-driver.log"
: > "$LOG"
say(){ echo "[$(date -u +%H:%M:%SZ)] $1" | tee -a "$LOG"; }

# 1) wait for the in-flight v2 floor arm to drain (token free)
say "waiting for exp-a-v2 to finish…"
for i in {1..50}; do
  grep -q 'full-remote done' "$OUT/exp-a-v2.log" 2>/dev/null && { say "exp-a-v2 done"; break; }
  sleep 30
done

run_arm(){
  local preset="$1" tag="$2"
  local alog="$OUT/exp-b-${tag}.log"
  say "START arm $tag ($preset)"
  ( cd "$ROOT"
    export QUANTA_FULL_REMOTE_CONCURRENCY=1 QUANTA_FULL_REMOTE_ONDEMAND=1 QUANTA_BENCH_AUTH_FILE="$AF"
    bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets --allow-extra-boxes \
      --dataset "$DS" --preset "$preset" --model gpt-5.4 2>&1 | tee "$alog" ) 
  local res=$(grep -oE 'resolved [0-9]+ \| unresolved [0-9]+' "$alog" | tail -1)
  say "DONE arm $tag — $res"
}

run_arm agentless-v3-thin-strict               b-v3strict
run_arm agentless-v3-thin-strict-select        b-select
run_arm agentless-v3-thin-strict-closure-select b-closure
say "PHASE B COMPLETE"

#!/bin/zsh
# Phase A+B launcher — jun-20 bench profile experiment matrix.
# One tmux session per (arm), one OAuth account per arm to decouple rate limits.
# Usage:
#   ./run-phase-AB.sh            # launch all arms whose auth slot exists
#   DRY=1 ./run-phase-AB.sh      # print the plan only, launch nothing
set -o pipefail
ROOT=/Users/songmin/quanta-codeagent-v3
OUT="${0:A:h}"                       # this script's dir = the built-dataset stamp dir
AUTHDIR="$HOME/.quanta/auth"

# arm = "session|dataset_stem|preset|auth_slot"
# auth_slot N -> $AUTHDIR/chatgpt.json (slot 1) or chatgpt-N.json (slot >=2)
ARMS=(
  "exp-a-v2|01-e-floor|agentless-v2|1"
  "exp-a-v3strict|01-e-floor|agentless-v3-thin-strict|2"
  "exp-b-v3strict|02-selector-stress|agentless-v3-thin-strict|3"
  "exp-b-select|02-selector-stress|agentless-v3-thin-strict-select|4"
  "exp-b-closure|02-selector-stress|agentless-v3-thin-strict-closure-select|5"
)

authfile_for_slot() {
  local slot="$1"
  if [ "$slot" = "1" ]; then echo "$AUTHDIR/chatgpt.json"; else echo "$AUTHDIR/chatgpt-${slot}.json"; fi
}

launched=0; skipped=0
for arm in "${ARMS[@]}"; do
  IFS='|' read -r session stem preset slot <<< "$arm"
  ds="$OUT/${stem}.jsonl"
  af="$(authfile_for_slot "$slot")"
  log="$OUT/${session}.log"
  if [ ! -f "$af" ]; then
    echo "SKIP  $session  (auth slot $slot missing: $af)"
    skipped=$((skipped+1)); continue
  fi
  echo "READY $session  preset=$preset  ds=$(basename "$ds")  auth=$(basename "$af")  -> $log"
  [ -n "$DRY" ] && continue
  tmux new-session -d -s "$session" /bin/zsh -lc "
    set -o pipefail
    cd '$ROOT'
    export QUANTA_FULL_REMOTE_CONCURRENCY=1
    export QUANTA_FULL_REMOTE_ONDEMAND=1
    export QUANTA_BENCH_AUTH_FILE='$af'
    bun run src/apps/bench/cli.ts grade \
      --mode full --allow-remote-secrets --allow-extra-boxes \
      --dataset '$ds' --preset '$preset' --model gpt-5.4 2>&1 | tee '$log'
  "
  launched=$((launched+1))
done
echo "---"
echo "launched=$launched skipped=$skipped"

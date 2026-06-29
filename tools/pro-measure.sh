#!/usr/bin/env bash
# SOTA++ Pro MEASUREMENT campaign (RFC jun-29). Drives the Python-Pro-266 subset to a real,
# CI'd resolved-rate — checkpoint-restartable, on-demand (no spot-reclaim loss), throttle-aware.
#
# Each round: ask the TESTED core (pro-measure-report --remaining) which ids are still ungraded,
# take the next CHUNK, grade it on a fresh on-demand box; reports persist per-instance so a kill/
# restart just resumes. Stops when the universe is fully graded or the wall cap hits. The final
# headline (solvability-gated rate + Wilson CI + vs external SOTA) prints from the same core.
#
#   DS         dataset jsonl              [default ~/.quanta/bench/datasets/pro-python-266.jsonl]
#   CHUNK      ids per box per round      [default 8]
#   MODEL      [default gpt-5.5]   PRESET [default agentless-v1 (LSP-optional, multilang-safe)]
#   MAX_HOURS  wall cap                   [default 12]
set -u
cd /Users/songmin/quanta-codeagent-v3 || exit 1
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export QUANTA_SWEBENCH_DATASET_FAMILY=pro
export QUANTA_FULL_REMOTE_ONDEMAND=1   # stable box — Pro grades are long; spot reclaim loses them

DS="${DS:-$HOME/.quanta/bench/datasets/pro-python-266.jsonl}"
CHUNK="${CHUNK:-8}"
MODEL="${MODEL:-gpt-5.5}"
PRESET="${PRESET:-agentless-v1}"
MAX_HOURS="${MAX_HOURS:-12}"
LOG=/tmp/pro-measure-supervisor.log
RUNLOG=/tmp/pro-measure-run.log
START=$(date +%s)
DEADLINE=$(( START + MAX_HOURS*3600 ))
ROUND=0
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
report(){ bun run tools/pro-measure-report.ts "$DS" 2>/dev/null; }
remaining(){ bun run tools/pro-measure-report.ts --remaining "$DS" 2>/dev/null; }

log "=== Pro-measure campaign start (dataset=$DS chunk=$CHUNK model=$MODEL preset=$PRESET cap=${MAX_HOURS}h dry=$DRY) ==="
log "$(report | tr '\n' ' ')"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ROUND=$((ROUND+1))
  ids=$(remaining | head -"$CHUNK" | paste -sd, -)
  if [ -z "$ids" ]; then
    log "=== COMPLETE — universe fully graded ==="
    break
  fi
  n=$(echo "$ids" | tr ',' '\n' | grep -c .)
  log "round $ROUND — grading $n ids: $ids"
  if [ "$DRY" = "1" ]; then
    log "[dry-run] would: grade --mode full --dataset $DS --dataset-family pro --instance <$n ids> --preset $PRESET --model $MODEL --allow-extra-boxes"
    break
  fi
  bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
    --dataset "$DS" --dataset-family pro --instance "$ids" \
    --preset "$PRESET" --model "$MODEL" --allow-extra-boxes >> "$RUNLOG" 2>&1
  rc=$?
  log "round $ROUND exited rc=$rc"
  # Throttle/box-loss self-heal: reports persist what DID grade; if a round graded nothing new
  # (rc!=0 + no progress), back off before retrying so we don't hammer a throttled account.
  before=$(echo "$ids" | tr ',' '\n' | grep -c .)
  stillpending=$(remaining | head -"$CHUNK" | grep -cFf <(echo "$ids" | tr ',' '\n') 2>/dev/null || echo "$before")
  if [ "$rc" != "0" ] && [ "$stillpending" -ge "$before" ]; then
    log "no progress (rc=$rc) — backing off 120s (throttle/box-loss)"
    sleep 120
  fi
done

log "=== Pro-measure campaign end (rounds=$ROUND, elapsed=$(( ($(date +%s)-START)/60 ))min) ==="
log "FINAL:"
report | while IFS= read -r line; do log "  $line"; done

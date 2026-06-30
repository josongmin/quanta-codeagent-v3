#!/usr/bin/env bash
# Live-5 self-heal supervisor (RFC jun-29). Plain nohup full-remote orchestrators get reaped
# (~15-20min) in this env → poller dies + box orphans. This loop relaunches the grade until a
# final report with all 5 instances graded, or a 3h wall cap. Each `grade --mode full` owns its
# own box lifecycle (provision → grade → terminate), so a clean exit leaves no orphan; a crash
# leaves at most one box, reaped by the +180min TTL.
set -u
cd /Users/songmin/quanta-codeagent-v3 || exit 1
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
# Live signals (drive the fork pip-spec + starryzhang namespace + box grading dataset default).
export QUANTA_SWEBENCH_DATASET_FAMILY=live
export QUANTA_SWEBENCH_DATASET_NAME=SWE-bench-Live/SWE-bench-Live

LOG=/tmp/live5-supervisor.log
RUNLOG=/tmp/live5-run.log
DS="$HOME/.quanta/bench/datasets/live-5.jsonl"
REPORTDIR="$HOME/Library/quanta-codeagent-v3/bench/full-remote"
START=$(date +%s)
DEADLINE=$(( START + 3*3600 ))
ATTEMPT=0
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== Live-5 supervisor start (family=live model=gpt-5.5 dataset=$DS) ==="
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ATTEMPT=$((ATTEMPT+1))
  log "attempt $ATTEMPT — launching grade --mode full --dataset-family live"
  bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
    --dataset "$DS" --dataset-family live --model gpt-5.5 --allow-extra-boxes \
    >> "$RUNLOG" 2>&1
  rc=$?
  log "attempt $ATTEMPT exited rc=$rc"
  # Completion: newest report touched after START with >=5 graded perInstance.
  latest=$(ls -t "$REPORTDIR"/report-i-*.json 2>/dev/null | head -1)
  if [ -n "${latest:-}" ]; then
    graded=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log((r.perInstance||[]).length)}catch(e){console.log(0)}' "$latest" 2>/dev/null || echo 0)
    res=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log((r.perInstance||[]).filter(x=>x.passed).length)}catch(e){console.log(0)}' "$latest" 2>/dev/null || echo 0)
    log "latest=$latest graded=$graded resolved=$res"
    if [ "${graded:-0}" -ge 5 ]; then
      log "=== COMPLETE: 5/5 graded, resolved=$res, report=$latest ==="
      break
    fi
  fi
  log "incomplete — retry in 30s (rc=$rc)"
  sleep 30
done
log "=== Live-5 supervisor end (attempts=$ATTEMPT, elapsed=$(( ($(date +%s)-START)/60 ))min) ==="

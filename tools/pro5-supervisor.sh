#!/usr/bin/env bash
# Pro-5 self-heal supervisor (RFC jun-29). Same shape as live5-supervisor.sh: relaunch the
# full-remote grade until a final report with all 5 graded, or a 3h wall cap. The box bootstrap
# clones the ScaleAI harness + builds its venv (setupProHarnessIfNeeded, gated on family=pro).
set -u
cd /Users/songmin/quanta-codeagent-v3 || exit 1
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
# Pro signal: drives the Scale-harness box wiring + the Pro parse/verify path.
export QUANTA_SWEBENCH_DATASET_FAMILY=pro
# Pro is MULTI-LANGUAGE (NodeBB=js/ts, qutebrowser/ansible=python). The default
# `agentless-v3-thin-strict` preset HARD-REFUSES any task whose language lacks a live LSP the
# box bootstraps (box has pyright only) → "requires typescript-language-server, refusing
# false-green". Use the LSP-OPTIONAL `agentless-v1` posture: uses pyright where present, grep/
# read elsewhere — no strict-live-grounding gate. The Scale harness grades regardless.
export QUANTA_BENCH_PRESET=agentless-v1

LOG=/tmp/pro5-supervisor.log
RUNLOG=/tmp/pro5-run.log
DS="$HOME/.quanta/bench/datasets/pro-5.jsonl"
REPORTDIR="$HOME/Library/quanta-codeagent-v3/bench/full-remote"
START=$(date +%s)
DEADLINE=$(( START + 3*3600 ))
ATTEMPT=0
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== Pro-5 supervisor start (family=pro model=gpt-5.5 dataset=$DS) ==="
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ATTEMPT=$((ATTEMPT+1))
  log "attempt $ATTEMPT — launching grade --mode full --dataset-family pro"
  bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
    --dataset "$DS" --dataset-family pro --model gpt-5.5 --preset agentless-v1 --allow-extra-boxes \
    >> "$RUNLOG" 2>&1
  rc=$?
  log "attempt $ATTEMPT exited rc=$rc"
  latest=$(ls -t "$REPORTDIR"/report-i-*.json 2>/dev/null | head -1)
  if [ -n "${latest:-}" ]; then
    fam=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).datasetFamily||"")}catch(e){console.log("")}' "$latest" 2>/dev/null)
    graded=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1])).perInstance||[]).length)}catch(e){console.log(0)}' "$latest" 2>/dev/null || echo 0)
    res=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1])).perInstance||[]).filter(x=>x.passed).length)}catch(e){console.log(0)}' "$latest" 2>/dev/null || echo 0)
    log "latest=$latest family=$fam graded=$graded resolved=$res"
    if [ "$fam" = "pro" ] && [ "${graded:-0}" -ge 5 ]; then
      log "=== COMPLETE: pro 5/5 graded, resolved=$res, report=$latest ==="
      break
    fi
  fi
  log "incomplete — retry in 30s (rc=$rc)"
  sleep 30
done
log "=== Pro-5 supervisor end (attempts=$ATTEMPT, elapsed=$(( ($(date +%s)-START)/60 ))min) ==="

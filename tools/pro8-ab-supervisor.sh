#!/usr/bin/env bash
# Pro-8 A/B self-heal supervisor (RFC jun-30 Phase 1). Runs the fixed 8-case Python-Pro
# smoke through TWO arms SERIALLY (never concurrent — concurrent grading = throttle +
# false-neg, jun-19), each as a relaunch-until-complete self-heal loop. On-demand boxes
# (no spot reclaim mid-grade). Reads acceptance_tier_*_rate from each report's closure
# diagnostics so the synthesis arm's tier distribution is visible (inert-canary).
set -u
cd /Users/songmin/quanta-codeagent-v3 || exit 1
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export QUANTA_SWEBENCH_DATASET_FAMILY=pro
export QUANTA_FULL_REMOTE_ONDEMAND=1

DS="$HOME/.quanta/bench/datasets/pro-python-8.jsonl"
REPORTDIR="$HOME/Library/quanta-codeagent-v3/bench/full-remote"
LOG=/tmp/pro8-ab-supervisor.log
RUNLOG=/tmp/pro8-ab-run.log
# Two arms: baseline (no acceptance ⇒ tier=na) then synthesis (acceptance ⇒ tier shows).
ARMS=("agentless-v6-oracle-hardened" "agentless-v7-oracle-multifile-synthesis")
PER_ARM_CAP=$(( 4*3600 ))   # 4h per arm
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

graded_of(){ node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1])).perInstance||[]).length)}catch(e){console.log(0)}' "$1" 2>/dev/null || echo 0; }
resolved_of(){ node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1])).perInstance||[]).filter(x=>x.passed).length)}catch(e){console.log(0)}' "$1" 2>/dev/null || echo 0; }
preset_of(){ node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.knobs?.preset||j.preset||"")}catch(e){console.log("")}' "$1" 2>/dev/null || echo ""; }

log "=== Pro-8 A/B supervisor start (model=gpt-5.5 dataset=$DS arms=${ARMS[*]}) ==="
for ARM in "${ARMS[@]}"; do
  export QUANTA_BENCH_PRESET="$ARM"   # env WINS over --preset (cli precedence)
  ARM_DEADLINE=$(( $(date +%s) + PER_ARM_CAP ))
  ATTEMPT=0
  log "--- ARM $ARM start (cap ${PER_ARM_CAP}s) ---"
  while [ "$(date +%s)" -lt "$ARM_DEADLINE" ]; do
    ATTEMPT=$((ATTEMPT+1))
    log "[$ARM] attempt $ATTEMPT — grade --mode full --dataset-family pro --preset $ARM"
    bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
      --dataset "$DS" --dataset-family pro --model gpt-5.5 --preset "$ARM" --allow-extra-boxes \
      >> "$RUNLOG" 2>&1
    rc=$?
    latest=$(ls -t "$REPORTDIR"/report-i-*.json 2>/dev/null | head -1)
    if [ -n "${latest:-}" ]; then
      g=$(graded_of "$latest"); r=$(resolved_of "$latest"); p=$(preset_of "$latest")
      log "[$ARM] attempt $ATTEMPT rc=$rc latest=$latest preset=$p graded=$g resolved=$r"
      if [ "$p" = "$ARM" ] && [ "${g:-0}" -ge 8 ]; then
        cp "$latest" "$REPORTDIR/AB-${ARM}.json" 2>/dev/null
        log "[$ARM] === COMPLETE 8/8 graded resolved=$r report=$latest (copied → AB-${ARM}.json) ==="
        break
      fi
    else
      log "[$ARM] attempt $ATTEMPT rc=$rc — no report yet"
    fi
    log "[$ARM] incomplete — retry in 30s"
    sleep 30
  done
  log "--- ARM $ARM end (attempts=$ATTEMPT) ---"
done
log "=== Pro-8 A/B supervisor DONE ==="

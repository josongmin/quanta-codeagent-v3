#!/usr/bin/env bash
# PARALLEL RED→green campaign. Maintains up to MAXBOX concurrent on-demand boxes,
# each 6 cases, winning config. NEVER kills a running orchestrator (clean exit
# self-terminates its EC2 box → no orphans). bash-3.2 safe (PID files, no assoc
# arrays). Harvest on completion → /tmp/green-tally.txt. Stops on queue-empty OR
# account-death. Adopts any pre-existing /tmp/camp-*.pid (e.g. a carried-over box).
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
QUEUE=/tmp/red-queue.txt
GREEN=/tmp/green-tally.txt
PROG=/tmp/campaign-progress.txt
RAW=tools/leaderboard-dashboard/rawdata/verified-full.jsonl
MAXBOX=5
BATCH=6
batch=$(ls /tmp/camp-p*.ids 2>/dev/null | grep -oE "[0-9]+" | sort -n | tail -1); batch=${batch:-100}
log() { echo "$(date +%H:%M:%S) $*" >> "$PROG"; }

harvest() {  # $1=tag (reads /tmp/camp-$1.log + sidecar)
  local tag=$1 iid r lost
  [ -s "$GREEN" ] || cp ~/.quanta-green-backup.txt "$GREEN" 2>/dev/null  # /tmp reaped mid-run → restore tally from off-/tmp backup
  touch "$GREEN" 2>/dev/null  # node readFileSync(GREEN) must never throw
  iid=$(grep -oE 'instance i-[0-9a-f]+' /tmp/camp-$tag.log 2>/dev/null | head -1 | awk '{print $2}')
  r=$(ls -t ~/Library/quanta-codeagent-v3/bench/full-remote/report-i-${iid#i-}*.json 2>/dev/null | head -1)
  if [ -n "$r" ]; then
    R="$r" GREEN="$GREEN" PROG="$PROG" TAG="$tag" node -e '
const d=require(process.env.R);const pi=d.perInstance||{};
const e=Array.isArray(pi)?pi:Object.entries(pi).map(([id,v])=>({id,...v}));
const fs=require("fs");let auth=0,n=e.length;
const seen=new Set(fs.readFileSync(process.env.GREEN,"utf8").split("\n"));
for(const x of e){const id=x.id||x.instanceId;
  if(x.passed && !seen.has(id)) fs.appendFileSync(process.env.GREEN,id+"\n");
  if(/not signed|token_invalidated|401|invalidated/.test(String(x.error||""))) auth++;
  fs.appendFileSync(process.env.PROG,"  "+(x.passed?"PASS":"fail")+" "+id+(x.error?" "+String(x.error).slice(0,16):"")+"\n");}
if(n>0 && auth===n) fs.writeFileSync("/tmp/CAMPAIGN_ACCOUNT_DEAD","dead\n");
const g=new Set(fs.readFileSync(process.env.GREEN,"utf8").split("\n").filter(Boolean)).size;
fs.appendFileSync(process.env.PROG,"  >> "+process.env.TAG+" done. cumulative green="+g+"\n");
'
    cp "$GREEN" ~/.quanta-green-backup.txt 2>/dev/null  # keep off-/tmp backup current after each harvest
  fi
  # box-loss (ssh-255/exit-137, NOT real attempts) → requeue precisely from log; stops queue-burning
  lost=$(grep -hoE 'still lost: .*' /tmp/camp-$tag.log 2>/dev/null | sed 's/still lost: //' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -E '^[a-z]' | sort -u)
  if [ -n "$lost" ]; then
    log "  $tag box-loss → requeue $(echo "$lost" | grep -c .)"; echo "$lost" >> "$QUEUE"
  elif [ -z "$r" ] && [ -f /tmp/camp-$tag.ids ]; then
    log "  $tag NO SIDECAR — requeue all"; cat /tmp/camp-$tag.ids >> "$QUEUE"
  fi
}

touch "$GREEN" 2>/dev/null
# Live OTEL: ensure operator trace sink is up (target for box reverse-tunnels).
# Live agent waterfall at http://localhost:4318 (replaces flaky box->local run.log tail).
if ! lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup bun src/apps/bench/otel-trace-sink.ts > /tmp/otel-sink.log 2>&1 &
  log "started OTEL trace sink :4318 - live span UI http://localhost:4318"
fi
log "=== PARALLEL campaign start MAXBOX=$MAXBOX queue=$(wc -l < "$QUEUE") ==="
while true; do
  [ -f /tmp/CAMPAIGN_ACCOUNT_DEAD ] && { log "ACCOUNT DEAD — pause (running boxes finish on their own)"; break; }
  # reap finished boxes
  for pf in /tmp/camp-*.pid; do
    [ -e "$pf" ] || continue
    p=$(cat "$pf" 2>/dev/null); tag=$(basename "$pf" .pid)
    if ! kill -0 "$p" 2>/dev/null; then harvest "$tag"; rm -f "$pf"; fi
  done
  running=$(ls /tmp/camp-*.pid 2>/dev/null | wc -l | tr -d ' ')
  if [ "$running" -ge "$MAXBOX" ]; then sleep 45; continue; fi
  ids=$(head -$BATCH "$QUEUE")
  if [ -z "$ids" ]; then
    [ "$running" -eq 0 ] && { log "QUEUE EMPTY — complete. green=$(sort -u "$GREEN" | grep -vc '^$')"; break; }
    sleep 45; continue
  fi
  tail -n +$((BATCH+1)) "$QUEUE" > "$QUEUE.t" && mv "$QUEUE.t" "$QUEUE"
  batch=$((batch+1)); tag="p$batch"
  echo "$ids" > /tmp/camp-$tag.ids
  IDS="$ids" python3 -c "import json,os;w=set(os.environ['IDS'].split());f=open('/tmp/camp-$tag.jsonl','w');[f.write(l) for l in open('$RAW') if json.loads(l).get('instance_id') in w]"
  QUANTA_BENCH_PRESET=agentless-v6-singlepass-execfull QUANTA_BENCH_NONEMPTY_FALLBACK=1 \
  QUANTA_BENCH_CONCURRENCY=1 QUANTA_OTEL_ENDPOINT=http://localhost:4318 QUANTA_OTEL_SERVICE_NAME="bench-$tag" \
    nohup bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
      --dataset /tmp/camp-$tag.jsonl --model gpt-5.5 --allow-extra-boxes \
      > /tmp/camp-$tag.log 2>&1 &
  echo $! > /tmp/camp-$tag.pid
  log "launch $tag (running now $((running+1))) ids=[$(echo $ids | tr '\n' ' ')]"
  sleep 25
done

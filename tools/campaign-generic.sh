#!/usr/bin/env bash
# Generic parameterized RED→green campaign (generalization of red-campaign.sh).
# Isolated per-namespace tmp paths so it never collides with a concurrent campaign.
# Env params:
#   CNS      namespace tag (e.g. w2, g54)         [required]
#   CQUEUE   path to queue file (one instance_id/line) [required]
#   CMODEL   model (e.g. gpt-5.5, gpt-5.4)         [default gpt-5.5]
#   CEXTRA   extra env exports, space-sep KEY=VAL  [optional, e.g. "QUANTA_LSP_PREWARM=0"]
#   CMAXBOX  max concurrent boxes                  [default 4]
#   CBATCH   instances per box                     [default 6]
# bash-3.2 safe. Clean exit self-terminates EC2 boxes (no orphans). Stops on
# queue-empty OR account-death. Harvest → /tmp/camp-$CNS-green.txt (NO backup restore).
set -uo pipefail
cd /Users/songmin/quanta-codeagent-v3
: "${CNS:?CNS required}"; : "${CQUEUE:?CQUEUE required}"
CMODEL="${CMODEL:-gpt-5.5}"; CEXTRA="${CEXTRA:-}"; CMAXBOX="${CMAXBOX:-4}"; CBATCH="${CBATCH:-6}"
QUEUE="$CQUEUE"
GREEN="/tmp/camp-$CNS-green.txt"
PROG="/tmp/camp-$CNS-progress.txt"
DEAD="/tmp/camp-$CNS-ACCOUNT_DEAD"
RAW=tools/leaderboard-dashboard/rawdata/verified-full.jsonl
batch=200
log() { echo "$(date +%H:%M:%S) $*" >> "$PROG"; }

harvest() {  # $1=tag
  local tag=$1 iid r
  touch "$GREEN"
  iid=$(grep -oE 'instance i-[0-9a-f]+' /tmp/camp-$CNS-$tag.log 2>/dev/null | head -1 | awk '{print $2}')
  r=$(ls -t ~/Library/quanta-codeagent-v3/bench/full-remote/report-i-${iid#i-}*.json 2>/dev/null | head -1)
  if [ -n "$r" ]; then
    R="$r" GREEN="$GREEN" PROG="$PROG" node -e '
const d=require(process.env.R);const pi=d.perInstance||[];
const e=Array.isArray(pi)?pi:Object.entries(pi).map(([id,v])=>({id,...v}));
const fs=require("fs");let auth=0,n=e.length;
const seen=new Set(fs.readFileSync(process.env.GREEN,"utf8").split("\n"));
for(const x of e){const id=x.id||x.instanceId;
  if(x.passed && !seen.has(id)) fs.appendFileSync(process.env.GREEN,id+"\n");
  if(/not signed|token_invalidated|401|invalidated/.test(String(x.error||""))) auth++;
  fs.appendFileSync(process.env.PROG,"  "+(x.passed?"PASS":"fail")+" "+id+"\n");}
if(n>0 && auth===n) fs.writeFileSync(process.env.DEAD_F||"/tmp/camp-DEAD","dead\n");
' DEAD_F="$DEAD"
  fi
}

touch "$GREEN"
if ! lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup bun src/apps/bench/otel-trace-sink.ts > /tmp/otel-sink-$CNS.log 2>&1 &
fi
log "=== campaign[$CNS] start model=$CMODEL extra='$CEXTRA' MAXBOX=$CMAXBOX queue=$(wc -l < "$QUEUE") ==="
while true; do
  [ -f "$DEAD" ] && { log "ACCOUNT DEAD — pause"; break; }
  for pf in /tmp/camp-$CNS-*.pid; do
    [ -e "$pf" ] || continue
    p=$(cat "$pf" 2>/dev/null); tag=$(basename "$pf" .pid); tag=${tag#camp-$CNS-}
    if ! kill -0 "$p" 2>/dev/null; then harvest "$tag"; rm -f "$pf"; fi
  done
  running=$(ls /tmp/camp-$CNS-*.pid 2>/dev/null | wc -l | tr -d ' ')
  if [ "$running" -ge "$CMAXBOX" ]; then sleep 45; continue; fi
  ids=$(head -$CBATCH "$QUEUE")
  if [ -z "$ids" ]; then
    [ "$running" -eq 0 ] && { log "QUEUE EMPTY — complete. green=$(sort -u "$GREEN" | grep -vc '^$')"; break; }
    sleep 45; continue
  fi
  tail -n +$((CBATCH+1)) "$QUEUE" > "$QUEUE.t" && mv "$QUEUE.t" "$QUEUE"
  batch=$((batch+1)); tag="b$batch"
  echo "$ids" > /tmp/camp-$CNS-$tag.ids
  IDS="$ids" python3 -c "import json,os;w=set(os.environ['IDS'].split());f=open('/tmp/camp-$CNS-$tag.jsonl','w');[f.write(l) for l in open('$RAW') if json.loads(l).get('instance_id') in w]"
  env QUANTA_BENCH_PRESET=agentless-v6-singlepass-execfull QUANTA_BENCH_NONEMPTY_FALLBACK=1 \
      QUANTA_BENCH_CONCURRENCY=1 QUANTA_OTEL_ENDPOINT=http://localhost:4318 QUANTA_OTEL_SERVICE_NAME="bench-$CNS-$tag" \
      $CEXTRA \
    nohup bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets \
      --dataset /tmp/camp-$CNS-$tag.jsonl --model "$CMODEL" --allow-extra-boxes \
      > /tmp/camp-$CNS-$tag.log 2>&1 &
  echo $! > /tmp/camp-$CNS-$tag.pid
  log "launch $tag (running $((running+1))) ids=[$(echo $ids | tr '\n' ' ')]"
  sleep 25
done

#!/usr/bin/env bash
# Pre-flight gate for a full-remote bench launch. EVERY failure mode this caused
# real waste in jun-27 is a CHECK here — fail any CRITICAL one and we DO NOT launch
# (no box spend, no account hit, no "throw it and debug the crater"). Usage:
#   bench-preflight.sh <dataset.jsonl> <model> <preset1> [preset2 ...]
# Exits 0 only if every CRITICAL check passes.
set -uo pipefail
cd "$(dirname "$0")/.."
DS="${1:?dataset required}"; MODEL="${2:?model required}"; shift 2; PRESETS=("$@")
FAIL=0; warn() { echo "  ⚠️  $*"; }; bad() { echo "  ❌ $*"; FAIL=1; }; ok() { echo "  ✅ $*"; }
echo "=== bench pre-flight ($(date +%H:%M:%S)) ==="

# 1) dataset exists + is valid jsonl + case count
if [ ! -s "$DS" ]; then bad "dataset $DS missing/empty"; else
  N=$(grep -c . "$DS" 2>/dev/null); BADJSON=$(node -e 'const fs=require("fs");let b=0;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){try{JSON.parse(l)}catch{b++}}console.log(b)' "$DS" 2>/dev/null)
  [ "${BADJSON:-1}" = "0" ] && ok "dataset $N cases, valid jsonl" || bad "dataset has $BADJSON malformed lines"
fi

# 2) model is EXPLICIT (not the gpt-5.4 default that silently ran in jun-27)
case "$MODEL" in gpt-5.5|gpt-5.4|gpt-*) ok "model=$MODEL (explicit)";; *) bad "model '$MODEL' looks wrong";; esac

# 3) presets exist in presets.ts
for p in "${PRESETS[@]}"; do
  grep -q "\"$p\":" src/runner/knobs/presets.ts && ok "preset $p defined" || bad "preset $p NOT in presets.ts"
done

# 4) account can actually STREAM the model (the jun-27 cap that 0-turned every case)
TOK=$(node -e 'try{const j=require(require("os").homedir()+"/.quanta/auth/chatgpt.json");console.log(j.access_token||j.tokens?.access_token||"")}catch{console.log("")}')
if [ -z "$TOK" ]; then bad "no access_token in ~/.quanta/auth/chatgpt.json"; else
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -X POST https://chatgpt.com/backend-api/codex/responses \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}],\"stream\":true,\"store\":false}" 2>/dev/null)
  [ "$CODE" = "200" ] && ok "account streams $MODEL (HTTP 200)" || bad "account CANNOT stream $MODEL (HTTP $CODE — cap/throttle/dead token)"
fi

# 5) no orphan c7i boxes (jun-27: killed grades left boxes burning ~80min)
ORPH=$(aws ec2 describe-instances --region ap-northeast-2 --filters "Name=instance-state-name,Values=running,pending" "Name=instance-type,Values=c7i.4xlarge" --query 'length(Reservations[].Instances[])' --output text 2>/dev/null)
if [ "${ORPH:-x}" = "x" ]; then bad "aws describe-instances FAILED (creds/region/network)"; else
  [ "${ORPH:-0}" = "0" ] && ok "no orphan c7i boxes" || warn "$ORPH c7i box(es) already running — terminate first or they cost + collide"
fi

# 6) OTEL sink port free (jun-27: a stale sink held 4318, the shared sink died)
if lsof -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then warn "port 4318 in use — a stale sink? (kill it or arms reuse it)"; else ok "port 4318 free for sink"; fi

# 7) known grading hazards in the dataset (jun-27: django-11141 = flaky python-version
#    selection ⇒ 'gold patch did not resolve' false-FAIL). Flag, don't block.
for hz in django__django-11141; do grep -q "\"$hz\"" "$DS" 2>/dev/null && warn "known grading-flaky case present: $hz (python-version mapping ⇒ possible false FAIL; exclude from tally)"; done

echo "==="
[ "$FAIL" = "0" ] && { echo "PRE-FLIGHT PASS — clear to launch"; exit 0; } || { echo "PRE-FLIGHT FAIL — DO NOT LAUNCH (fix the ❌ above)"; exit 1; }

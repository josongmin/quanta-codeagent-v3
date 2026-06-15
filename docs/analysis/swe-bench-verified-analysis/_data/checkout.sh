#!/usr/bin/env bash
# Check out the base_commit for a SWE-bench Verified instance in its cloned repo.
#
#   docs/analysis/swe-bench-verified-analysis/_data/checkout.sh django__django-11099
#
# Reads repo + base_commit from verified-full.jsonl and checks it out under
# ~/swe-bench-repos/<repo-basename>. Repos must already be cloned (see README).
set -euo pipefail

ID="${1:?usage: checkout.sh <instance_id>}"
DATA="$(cd "$(dirname "$0")" && pwd)/verified-full.jsonl"
ROOT="${SWE_BENCH_REPOS:-$HOME/swe-bench-repos}"

read -r REPO COMMIT < <(python3 -c "
import json,sys
for line in open('$DATA'):
    r=json.loads(line)
    if r['instance_id']=='$ID':
        print(r['repo'], r['base_commit']); sys.exit(0)
sys.exit('instance not found: $ID')
")

DIR="$ROOT/$(basename "$REPO")"
[ -d "$DIR/.git" ] || { echo "repo not cloned: $DIR" >&2; exit 1; }
echo "checkout $REPO @ $COMMIT  ->  $DIR"
git -C "$DIR" checkout -q "$COMMIT"
echo "done. cd $DIR"

#!/usr/bin/env bash
# Tally the lever-#2 (verify-before-finalize) outcomes across a Terminal-Bench results dir.
#
# review P1: report.verification was recorded into AgentContext.metadata (→ result.json) but had NO
# consumer. This is that consumer — it surfaces the verified-pass / verified-fail / unverifiable
# distribution so a QUANTA_TB_VERIFY_GATE=1 A/B run is interpretable (e.g. "gate fired on N runs,
# M were fake-green caught as unverifiable/verified-fail"). Read-only; safe to run against a live dir.
#
# Usage: tally-verification.sh [RESULTS_DIR]      (default: ~/tb-results/full89)
set -euo pipefail
OUT="${1:-$HOME/tb-results/full89}"
node -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const counts = { "verified-pass": 0, "verified-fail": 0, "unverifiable": 0, "(no stamp)": 0 };
let runs = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "result.json") {
      runs++;
      let state;
      try { state = JSON.parse(fs.readFileSync(p)).agent_result?.metadata?.verification?.state; } catch { /* garbled */ }
      counts[state && state in counts ? state : "(no stamp)"]++;
    }
  }
};
try { walk(root); } catch { console.error(`no results under ${root}`); process.exit(1); }
console.log(`verify-gate outcomes across ${runs} runs in ${root}:`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
const stamped = runs - counts["(no stamp)"];
console.log(`  ${"stamped".padEnd(12)} ${stamped} (${runs ? Math.round((stamped / runs) * 100) : 0}% — gate engaged)`);
' "$OUT"

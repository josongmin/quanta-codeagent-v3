#!/usr/bin/env bash
# S1 self-test discipline A/B (RFC jul-3). Box-side. Two arms over the consistent-synthesis-failure
# targets: OFF = OWNED+VG+OC1; ON = +QUANTA_TB_SELF_TEST. Emits per-task reward + the S1b receipt
# (selfTest.executed/green) so we can compute the top-line metric (self-test↔hidden alignment).
#   run-selftest-ab.sh [k]     k = attempts per task (default 1)
set -u
K="${1:-1}"
export PATH="$HOME/.bun/bin:$HOME/tb-venv/bin:$PATH"; source ~/tb-venv/bin/activate 2>/dev/null
cd ~/quanta-codeagent-v3
export QUANTA_TERMINAL_BRAIN_CMD="$HOME/tb-venv/bin/quanta-terminal-brain"

# S1 targets: our failures ∩ others' successes, dominated by consistent synthesis errors (0/3).
TARGETS="polyglot-c-py rstan-to-pystan sam-cell-seg pytorch-model-recovery model-extraction-relu-logits"
INC=""; for t in $TARGETS; do INC="$INC -i $t"; done

run_arm() {
  local arm="$1"; shift
  unset QUANTA_TB_ENV_OWNED QUANTA_MAX_TURNS QUANTA_TB_VERIFY_GATE QUANTA_TB_OUTPUT_CONTRACT QUANTA_TB_SELF_TEST
  export QUANTA_TB_ENV_OWNED=1 QUANTA_MAX_TURNS=60 QUANTA_TB_VERIFY_GATE=1 QUANTA_TB_OUTPUT_CONTRACT=1
  [ "$arm" = "on" ] && export QUANTA_TB_SELF_TEST=1
  local OUT="$HOME/tb-results/ab-selftest-$arm"; rm -rf "$OUT"; mkdir -p "$OUT"
  export QUANTA_TB_BRAIN_LOG_DIR="$HOME/tb-results/ab-selftest-$arm-blogs"; rm -rf "$QUANTA_TB_BRAIN_LOG_DIR"
  echo "[ab arm=$arm k=$K SELF_TEST=${QUANTA_TB_SELF_TEST:-0}] $(date -u +%H:%M:%S)"
  harbor run -d terminal-bench $INC --agent-import-path quanta_agent:QuantaAgent -m gpt-5.5 -k "$K" -n 8 -o "$OUT" \
    > "$HOME/ab-selftest-$arm.log" 2>&1
  echo "[ab arm=$arm DONE $?] $(date -u +%H:%M:%S)"
}

run_arm off
run_arm on

# ── tally: reward + selfTest receipt per task per arm ──
# The brain report is NOT persisted as report.json (that goes to a /tmp dir harbor discards). harbor
# embeds it into <trial>/result.json → agent_result.metadata (verification + selfTest live there).
echo "==================== S1 A/B RESULT ===================="
python3 - "$HOME" "$TARGETS" <<'PY'
import json, sys, glob, os
home, targets = sys.argv[1], sys.argv[2].split()
def trials(arm, t):
    return sorted(glob.glob(f"{home}/tb-results/ab-selftest-{arm}/*/{t}__*"))
def reward(d):
    try: return open(f"{d}/verifier/reward.txt").read().strip()
    except: return None
def meta(d):
    try:
        r = json.load(open(f"{d}/result.json"))
        return (r.get("agent_result") or {}).get("metadata") or {}
    except: return {}
print("legend: PASS/FAIL=reward | receipt EG=self-test ran+green, E-=ran+failed, ··=none | vg=verification.state")
for arm in ("off", "on"):
    print(f"── arm={arm} ──")
    for t in targets:
        ds = trials(arm, t)
        if not ds:
            print(f"  {'?':<4}  {t}  (no trial dir)"); continue
        best = "FAIL"; rc = "··"; vg = "-"
        for d in ds:
            r = reward(d)
            if r == "1": best = "PASS"
            m = meta(d)
            st = m.get("selfTest")
            if st is not None:
                rc = ("E" if st.get("executed") else "-") + ("G" if st.get("green") else "-")
            v = m.get("verification")
            if v: vg = v.get("state", "-")
        print(f"  {best:<4}  receipt={rc}  vg={vg:<13}  {t}")
PY

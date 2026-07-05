#!/usr/bin/env bash
# Terminal-Bench smoke (jul-5) — 7 tasks in ONE run, latest lever stack.
#
#   smoke-terminal-bench-ver-jul-5.sh [best_of_n]
#     no arg  → single run per task
#     2..4    → best-of-N fair selection per task (Nx cost)
#
# TASKS (7):
#   GUARD (2)   — tasks we ALREADY pass (competitor 100% + ours green). A red here
#                 = the lever stack BROKE something ⇒ 🔴 SMOKE FAIL (regression).
#   TARGETS (5) — our fail ∩ others' pass. red→green = that failure class is solved.
#
# LEVER STACK — each knob targets a failure class present in the 5 targets:
#   ENV_OWNED       install/env posture (validated jul-2)
#   VERIFY_GATE     verify-before-submit
#   OUTPUT_CONTRACT Type1: dirty-exit deliverable follow-up (sam-cell-seg exit 2)
#   WRITE_TOOL      file-is-deliverable exact-byte authoring (polyglot)
#   SELF_TEST       Type2 synthesis: build+run a spec-derived self-test to green
#   ORACLE_LOOP=2   Type2 synthesis: harness-enforced self-test→green feedback (K=2)
#   (TRAJECTORY is default-ON — kept for RCA.)
#
# Box-side (needs ~/tb-venv + harbor + the quanta-terminal-brain shim). Cheap iteration,
# NOT a full run. Records the winning knob set in the header line (feedback-record-winning-config).
set -u

BON="${1:-}"
MODEL="${TB_MODEL:-gpt-5.5}"        # override with TB_MODEL=... if the model bumps
TURNS="${TB_MAX_TURNS:-60}"

export PATH="$HOME/.bun/bin:$HOME/tb-venv/bin:$PATH"
source ~/tb-venv/bin/activate 2>/dev/null
cd ~/quanta-codeagent-v3
export QUANTA_TERMINAL_BRAIN_CMD="$HOME/tb-venv/bin/quanta-terminal-brain"
export QUANTA_TB_BRAIN_LOG_DIR="$HOME/tb-results/jul5-blogs"; rm -rf "$QUANTA_TB_BRAIN_LOG_DIR"

# ── latest lever stack ──
unset QUANTA_TB_ENV_OWNED QUANTA_MAX_TURNS QUANTA_TB_VERIFY_GATE QUANTA_TB_OUTPUT_CONTRACT \
      QUANTA_TB_WRITE_TOOL QUANTA_TB_SELF_TEST QUANTA_TB_ORACLE_LOOP QUANTA_TB_BEST_OF_N
export QUANTA_TB_ENV_OWNED=1
export QUANTA_MAX_TURNS="$TURNS"
export QUANTA_TB_VERIFY_GATE=1
export QUANTA_TB_OUTPUT_CONTRACT=1
export QUANTA_TB_WRITE_TOOL=1
export QUANTA_TB_SELF_TEST=1
export QUANTA_TB_ORACLE_LOOP=2
[ -n "$BON" ] && export QUANTA_TB_BEST_OF_N="$BON"

GUARD="fix-git regex-log"
TARGETS="polyglot-c-py rstan-to-pystan sam-cell-seg pytorch-model-recovery model-extraction-relu-logits"
ALL="$GUARD $TARGETS"
INC=""; for t in $ALL; do INC="$INC -i $t"; done

OUT="$HOME/tb-results/jul5"; rm -rf "$OUT"; mkdir -p "$OUT"
echo "[tb-jul5] tasks=$(echo $ALL|wc -w) model=$MODEL n=8 | stack: OWNED TURNS=$TURNS VG OC1 WRITE SELF_TEST ORACLE=2 BON=${QUANTA_TB_BEST_OF_N:-off}"

harbor run -d terminal-bench $INC --agent-import-path quanta_agent:QuantaAgent \
  -m "$MODEL" -n 8 -o "$OUT" > "$HOME/tb-jul5-run.log" 2>&1

# ── tally: reward + receipts (verify-gate state · self-test executed/green · oracle rounds) ──
echo "==================== TB JUL-5 RESULT ===================="
python3 - "$OUT" "$GUARD" "$TARGETS" <<'PY'
import json, sys, glob
out, guard, targets = sys.argv[1], sys.argv[2].split(), sys.argv[3].split()
def trials(t): return sorted(glob.glob(f"{out}/*/{t}__*"))
def reward(d):
    try: return open(f"{d}/verifier/reward.txt").read().strip()
    except Exception: return None
def meta(d):
    try:
        r = json.load(open(f"{d}/result.json"))
        return (r.get("agent_result") or {}).get("metadata") or {}
    except Exception: return {}
def row(t):
    ds = trials(t)
    if not ds: return "?", "··", "-", "-"
    best, rc, vg, orc = "FAIL", "··", "-", "-"
    for d in ds:
        if reward(d) == "1": best = "PASS"
        m = meta(d)
        st = m.get("selfTest")
        if st is not None:
            rc = ("E" if st.get("executed") else "-") + ("G" if st.get("green") else "-")
        v = m.get("verification")
        if v: vg = v.get("state", "-")
        ol = m.get("oracleLoop") or m.get("oracle_loop")
        if isinstance(ol, dict) and ol.get("rounds") is not None: orc = str(ol.get("rounds"))
    return best, rc, vg, orc
print("legend: PASS/FAIL=reward | receipt EG=self-test ran+green E-=ran+red ··=none | vg=verify-gate state | orc=oracle rounds")
guard_red = 0
print("── GUARD (must stay green; red = 🔴 SMOKE FAIL) ──")
for t in guard:
    b, rc, vg, orc = row(t)
    print(f"  {b:<4}  receipt={rc}  vg={vg:<12}  orc={orc}  {t}")
    if b != "PASS": guard_red += 1
tgt_pass = 0
print("── TARGETS (red→green = solved) ──")
for t in targets:
    b, rc, vg, orc = row(t)
    print(f"  {b:<4}  receipt={rc}  vg={vg:<12}  orc={orc}  {t}")
    if b == "PASS": tgt_pass += 1
print("────────────────────────────")
print(f"TB_JUL5 | targets {tgt_pass}/{len(targets)} solved | guard {len(guard)-guard_red}/{len(guard)} green")
print("🔴 SMOKE FAIL: guard regressed" if guard_red else "✅ guard green")
PY

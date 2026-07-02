#!/usr/bin/env bash
# TB 스모크 러너 (RFC 07) — 승산 타겟 + 회귀 가드 3건만 (풀런 금지, 저렴 반복용).
#   run-tb-smoke.sh <profile>   profile = baseline | levers | oc1
# 박스에서 실행. 태스크별 PASS/FAIL + 회귀(green→red) SMOKE-FAIL 판정.
set -u
PROFILE="${1:-oc1}"
export PATH="$HOME/.bun/bin:$HOME/tb-venv/bin:$PATH"; source ~/tb-venv/bin/activate 2>/dev/null
cd ~/quanta-codeagent-v3
export QUANTA_TERMINAL_BRAIN_CMD="$HOME/tb-venv/bin/quanta-terminal-brain"
export QUANTA_TB_BRAIN_LOG_DIR="$HOME/tb-results/smoke-$PROFILE-blogs"

# ── knob 프로파일 ──
unset QUANTA_TB_ENV_OWNED QUANTA_MAX_TURNS QUANTA_TB_VERIFY_GATE QUANTA_TB_OUTPUT_CONTRACT
case "$PROFILE" in
  baseline) ;;
  levers)   export QUANTA_TB_ENV_OWNED=1 QUANTA_MAX_TURNS=60 QUANTA_TB_VERIFY_GATE=1 ;;
  oc1)      export QUANTA_TB_ENV_OWNED=1 QUANTA_MAX_TURNS=60 QUANTA_TB_VERIFY_GATE=1 QUANTA_TB_OUTPUT_CONTRACT=1 ;;
  *) echo "unknown profile: $PROFILE (baseline|levers|oc1)"; exit 2 ;;
esac

# 안정 가드: 경쟁사 100% + 우리도 baseline·레버 둘 다 통과여야. red면 SMOKE FAIL.
GUARD="fix-git regex-log"
# 레버-회귀 witness: 경쟁사 100%인데 레버 켜니 우리가 깨진 것(M0 jul-3 확정). green되면 회귀 고쳐진 것.
LEVER_REGRESSION="extract-elf path-tracing headless-terminal"
# 승산 타겟: 우리 실패 ∩ 남들 성공. green되면 회복.
TARGETS="polyglot-c-py rstan-to-pystan sam-cell-seg pytorch-model-recovery model-extraction-relu-logits"
ALL="$GUARD $LEVER_REGRESSION $TARGETS"
INC=""; for t in $ALL; do INC="$INC -i $t"; done

OUT="$HOME/tb-results/smoke-$PROFILE"; rm -rf "$OUT"; mkdir -p "$OUT"
echo "[tb-smoke] profile=$PROFILE tasks=$(echo $ALL|wc -w) knobs: OWNED=${QUANTA_TB_ENV_OWNED:-} TURNS=${QUANTA_MAX_TURNS:-} VG=${QUANTA_TB_VERIFY_GATE:-} OC1=${QUANTA_TB_OUTPUT_CONTRACT:-}"
harbor run -d terminal-bench $INC --agent-import-path quanta_agent:QuantaAgent -m gpt-5.5 -n 8 -o "$OUT" > "$HOME/smoke-$PROFILE-run.log" 2>&1

# ── 결과 판정 ──
res() { local t="$1"; local x; x=$(ls -d "$OUT"/*/${t}__* 2>/dev/null|head -1); [ -z "$x" ]&&{ echo "?"; return; }; local r; r=$(cat "$x/verifier/reward.txt" 2>/dev/null); [ "$r" = "1" ]&&echo PASS||echo FAIL; }
echo "── GUARD 안정가드 (green이어야, red=SMOKE FAIL) ──"
GUARD_FAIL=0
for t in $GUARD; do v=$(res "$t"); echo "  $v  $t"; [ "$v" != "PASS" ]&&GUARD_FAIL=$((GUARD_FAIL+1)); done
echo "── LEVER_REGRESSION 레버-회귀 witness (green되면 회귀 복구) ──"
LR_OK=0
for t in $LEVER_REGRESSION; do v=$(res "$t"); echo "  $v  $t"; [ "$v" = "PASS" ]&&LR_OK=$((LR_OK+1)); done
echo "── TARGETS 승산타겟 (green되면 회복) ──"
TGT_PASS=0
for t in $TARGETS; do v=$(res "$t"); echo "  $v  $t"; [ "$v" = "PASS" ]&&TGT_PASS=$((TGT_PASS+1)); done
echo "────────────────────────────"
echo "TB_SMOKE profile=$PROFILE | 타겟회복 $TGT_PASS/$(echo $TARGETS|wc -w) | 회귀복구 $LR_OK/$(echo $LEVER_REGRESSION|wc -w) | 안정가드 $(( $(echo $GUARD|wc -w) - GUARD_FAIL))/$(echo $GUARD|wc -w) green"
[ "$GUARD_FAIL" -gt 0 ] && echo "🔴 SMOKE FAIL: 안정가드 $GUARD_FAIL건 red" || echo "✅ 안정가드 green"

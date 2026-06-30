#!/usr/bin/env python3
"""
Cassette turn analyzer — CHEAP ($0, no box) counterfactual over RECORDED bench runs.

Answers two questions the django-11138 v7 run raised, without re-running anything:
  A) OVER-VERIFICATION TAX: for instances a CHEAP preset (v1/v2/v3, single-pass-ish)
     AND a HEAVY preset (v6/v7 — breadth + repro-vote + acceptance + closure-repair)
     BOTH resolve, how many MORE turns does the heavy stack burn for the same PASS?
     (Heavy turns / cheap turns. >1 ⇒ pure over-verification on an already-solvable case.)
  B) PHASE PROFILE: from each trajectory cassette, where do the turns GO —
     pre-edit (localize + repro-generation), edit-converge, post-last-edit tail
     (pure re-verification)? Locates the gate target.

Data sources (read-only, on disk):
  - reports:  ~/.quanta/bench/results/*.json + ~/Library/.../full-remote/report*.json
  - cassettes: ~/Library/.../full-remote/trajectory-*.jsonl

NO LLM, NO EC2. Pure replay-of-record. Run: python3 tools/cassette-turn-analyzer.py
"""
from __future__ import annotations

import glob
import json
import os
import re
import statistics
from collections import defaultdict

HOME = os.path.expanduser("~")
REPORT_GLOBS = [
    f"{HOME}/.quanta/bench/results/*.json",
    f"{HOME}/Library/quanta-codeagent-v3/bench/full-remote/report*.json",
]
TRAJ_GLOB = f"{HOME}/Library/quanta-codeagent-v3/bench/full-remote/trajectory-*.jsonl"

EDIT_TOOLS = {"edit", "write", "apply_patch", "apply_patch_structured", "scripted_replace"}


def preset_weight(preset: str | None) -> str:
    """Classify a preset as 'cheap' (light verify) or 'heavy' (breadth/repro-vote/
    acceptance/closure-repair stack). Unknown ⇒ 'other' (excluded from the tax)."""
    if not preset:
        return "other"
    p = preset.lower()
    if any(t in p for t in ("v6", "v7", "reprovote", "oracle", "acceptance", "breadth")):
        return "heavy"
    if any(t in p for t in ("v1", "v2", "v3", "thin", "singlepass")):
        return "cheap"
    return "other"


def load_reports() -> dict:
    """instance_id -> list of {preset, weight, passed, turns, patchBytes, model}."""
    by_inst: dict[str, list] = defaultdict(list)
    seen_files = set()
    for g in REPORT_GLOBS:
        for f in glob.glob(g):
            rf = os.path.realpath(f)
            if rf in seen_files:
                continue
            seen_files.add(rf)
            try:
                d = json.load(open(f))
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            preset = (d.get("knobs") or {}).get("preset") if isinstance(d.get("knobs"), dict) else None
            model = d.get("model")
            for r in d.get("perInstance") or []:
                if not isinstance(r, dict) or r.get("turns") is None:
                    continue
                by_inst[r.get("id")].append({
                    "preset": preset,
                    "weight": preset_weight(preset),
                    "passed": bool(r.get("passed")),
                    "turns": r.get("turns"),
                    "patchBytes": r.get("patchBytes"),
                    "model": model,
                })
    return by_inst


def over_verification_tax(by_inst: dict) -> None:
    """For instances BOTH a cheap and a heavy preset PASS, heavy/cheap turn ratio."""
    ratios = []
    rows = []
    for inst, runs in by_inst.items():
        cheap = [r for r in runs if r["weight"] == "cheap" and r["passed"] and r["turns"]]
        heavy = [r for r in runs if r["weight"] == "heavy" and r["passed"] and r["turns"]]
        if not cheap or not heavy:
            continue
        c = min(r["turns"] for r in cheap)  # best (fewest-turn) cheap solve
        h = min(r["turns"] for r in heavy)  # best heavy solve
        ratios.append(h / c)
        rows.append((h / c, inst, c, h))
    print("=== A) OVER-VERIFICATION TAX (instances BOTH cheap & heavy preset PASS) ===")
    if not ratios:
        print("  (no instance solved by both a cheap AND a heavy preset yet — need more runs)")
        return
    rows.sort(reverse=True)
    print(f"  n={len(ratios)} instances | heavy/cheap turn ratio:"
          f" median={statistics.median(ratios):.1f}x mean={statistics.mean(ratios):.1f}x"
          f" max={max(ratios):.1f}x")
    print("  worst over-spends (heavy burned N× the cheap turns for the SAME pass):")
    for ratio, inst, c, h in rows[:10]:
        print(f"    {ratio:4.1f}x  cheap={c:3d}t  heavy={h:3d}t  {inst}")


def heavy_value(by_inst: dict) -> None:
    """The TRADEOFF trio: where does the heavy stack EARN its 2x tax vs waste it?
      - heavy_only : cheap FAILS (or never tried) but heavy PASSES → heavy's unique wins
      - both_pass  : the over-verification tax class (A)
      - cheap_only : cheap PASSES but heavy FAILS → heavy REGRESSED (worrying)
    A gate that early-exits on a clean round-0 is SAFE iff heavy_only cases are
    ones the round-0 would NOT look clean on (so the gate escalates them) — this
    counts the population; the per-case round-0 cleanliness needs the trajectory."""
    heavy_only = both = cheap_only = 0
    heavy_only_ex = []
    for inst, runs in by_inst.items():
        cp = any(r["weight"] == "cheap" and r["passed"] for r in runs)
        cf = any(r["weight"] == "cheap" and not r["passed"] for r in runs)
        hp = any(r["weight"] == "heavy" and r["passed"] for r in runs)
        hf = any(r["weight"] == "heavy" and not r["passed"] for r in runs)
        if hp and cp:
            both += 1
        elif hp and cf and not cp:
            heavy_only += 1
            heavy_only_ex.append(inst)
        elif cp and hf and not hp:
            cheap_only += 1
    print("\n=== C) DOES THE HEAVY STACK EARN ITS TAX? (recorded pass/fail by weight) ===")
    print(f"  heavy_only (cheap FAILS, heavy PASSES — the stack's unique wins) : {heavy_only}")
    print(f"  both_pass  (the ~2x over-verification tax class)                 : {both}")
    print(f"  cheap_only (cheap PASSES, heavy FAILS — heavy regressed)         : {cheap_only}")
    if heavy_only or both:
        denom = heavy_only + both
        print(f"  ⇒ heavy's PASSES that cheap could NOT get: {heavy_only}/{denom} "
              f"({100*heavy_only//denom}%). The other {both} paid the tax for nothing.")
    if heavy_only_ex:
        print(f"  heavy-only wins (gate must NOT early-exit these): {', '.join(heavy_only_ex[:8])}")


def phase_profile(traj_path: str) -> dict | None:
    """From a trajectory cassette: total turns, first/last edit turn ⇒ phase split."""
    try:
        lines = open(traj_path).read().splitlines()
    except Exception:
        return None
    n = len(lines)
    if n == 0:
        return None
    first_edit = last_edit = None
    for idx, ln in enumerate(lines):
        try:
            evs = (json.loads(ln).get("events")) or []
        except Exception:
            continue
        for e in evs:
            if isinstance(e, dict) and e.get("type") == "tool_use_start" and e.get("name") in EDIT_TOOLS:
                if first_edit is None:
                    first_edit = idx
                last_edit = idx
    inst = re.sub(r".*trajectory-|\.jsonl$", "", traj_path)
    return {"inst": inst, "turns": n, "first_edit": first_edit, "last_edit": last_edit}


def phase_report() -> None:
    print("\n=== B) PHASE PROFILE (where the turns go, per recorded cassette) ===")
    profs = [p for p in (phase_profile(t) for t in glob.glob(TRAJ_GLOB)) if p]
    if not profs:
        print("  (no trajectory cassettes found)")
        return
    print(f"  {len(profs)} cassette(s). pre-edit = localize+repro-gen; tail = post-last-edit re-verify")
    for p in sorted(profs, key=lambda x: -x["turns"])[:12]:
        n, fe, le = p["turns"], p["first_edit"], p["last_edit"]
        if fe is None:
            print(f"    turns={n:3d}  NO EDITS (no-patch?)  {p['inst'][:30]}")
            continue
        pre = fe
        converge = le - fe
        tail = n - le
        print(f"    turns={n:3d}  pre-edit={pre:3d}({100*pre//n:2d}%)  converge={converge:3d}  "
              f"tail={tail:3d}({100*tail//n:2d}%)  {p['inst'][:30]}")
    # aggregate
    full = [p for p in profs if p["first_edit"] is not None]
    if full:
        pre_pct = statistics.median(100 * p["first_edit"] / p["turns"] for p in full)
        tail_pct = statistics.median(100 * (p["turns"] - p["last_edit"]) / p["turns"] for p in full)
        print(f"  MEDIAN: pre-edit={pre_pct:.0f}% of turns | post-last-edit tail={tail_pct:.0f}%")
        print(f"  ⇒ a gate that early-exits when round-0 is strong-oracle-clean reclaims the TAIL;")
        print(f"    a localize/repro-gen confidence gate reclaims the PRE-EDIT share.")


if __name__ == "__main__":
    by_inst = load_reports()
    print(f"loaded {sum(len(v) for v in by_inst.values())} run-rows across {len(by_inst)} instances\n")
    over_verification_tax(by_inst)
    heavy_value(by_inst)
    phase_report()

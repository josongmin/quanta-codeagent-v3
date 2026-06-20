#!/usr/bin/env python3
"""Repro-gen reliability measurement — LLM-free, reads campaign report.json.

The bottleneck (jun-20): verify-and-select's resolved-gate is inert for ~half
the instances because repro GENERATION fails (n=295: 54% success). Two levers
landed/pending:
  - FLOOR fix (commit 874bd625, 2026-06-20 13:58 KST): uv python floored at 3.9
    → kills the `No interpreter found for Python 3.6` execution_failed mode.
  - adversarial-repro knob (QUANTA_BENCH_ADVERSARIAL_REPRO=1, UNMEASURED):
    targets the `no_reproduced_candidate` mode (repro doesn't go base-RED).

This script harvests `reproTest` telemetry from every report and slices the
repro-gen success rate by (era × adversarial-repro), plus tracks the residual
`No interpreter` errors that the floor fix must drive to 0. NO new runs — it
reads what the campaign already produced. Re-run any time as data accumulates.

To FEED the adversarial-repro arm: run a batch with
  QUANTA_BENCH_PRESET=agentless-v1 QUANTA_BENCH_ADVERSARIAL_REPRO=1 ...
(reproTest + the knob both land in report.json; this script auto-detects it).
"""
import glob
import json
import os
import time
from collections import Counter

REPORTS = os.path.expanduser("~/Library/quanta-codeagent-v3/bench/full-remote/report-*.json")
FLOOR_EPOCH = time.mktime(time.strptime("2026-06-20 13:58", "%Y-%m-%d %H:%M"))


def era(mtime: float) -> str:
    return "post-floor" if mtime >= FLOOR_EPOCH else "pre-floor"


def adv_on(report: dict) -> bool:
    k = report.get("knobs", {}).get("resolved", {}).get("adversarial-repro")
    return bool(k)  # present+truthy ⇒ knob active


def main() -> None:
    files = glob.glob(REPORTS)
    # dedupe by (era, adv, instance) keeping latest
    rows: dict = {}
    for f in sorted(files, key=os.path.getmtime):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        e, adv, mt = era(os.path.getmtime(f)), adv_on(d), os.path.getmtime(f)
        for p in d.get("perInstance", []):
            rt = p.get("reproTest")
            if not rt:
                continue
            rows[(e, adv, p["id"])] = rt

    def slice_rate(pred):
        sel = [(k, rt) for k, rt in rows.items() if pred(k)]
        n = len(sel)
        ok = sum(1 for _, rt in sel if rt.get("installed"))
        reasons = Counter(rt.get("reason", "?") for _, rt in sel if not rt.get("installed"))
        nointerp = sum(
            1
            for _, rt in sel
            if not rt.get("installed")
            and "No interpreter" in (rt.get("sampleStderrTail", "") or rt.get("sampleStdoutTail", "") or "")
        )
        return n, ok, reasons, nointerp

    print(f"reports={len(files)}  unique (era,adv,instance) reproTest rows={len(rows)}\n")
    print("=== repro-gen success by ERA (floor fix = 874bd625 @ 13:58 KST) ===")
    for e in ("pre-floor", "post-floor"):
        n, ok, reasons, ni = slice_rate(lambda k, e=e: k[0] == e)
        if n:
            print(f"  {e:10} {ok:3}/{n:3} = {ok * 100 // n:3}%  | No-interpreter residual: {ni}  | fails: {dict(reasons)}")
    print("\n=== repro-gen success by ADVERSARIAL-REPRO (the unmeasured lever) ===")
    for adv in (False, True):
        n, ok, reasons, _ = slice_rate(lambda k, adv=adv: k[1] == adv)
        if n:
            print(f"  adv-repro={'ON ' if adv else 'OFF'} {ok:3}/{n:3} = {ok * 100 // n:3}%  | fails: {dict(reasons)}")
        else:
            print(f"  adv-repro={'ON ' if adv else 'OFF'} (no data yet — run a QUANTA_BENCH_ADVERSARIAL_REPRO=1 batch)")
    # post-floor × adv (the clean comparison once both exist)
    print("\n=== CLEAN A/B: post-floor only, adv ON vs OFF ===")
    for adv in (False, True):
        n, ok, _, _ = slice_rate(lambda k, adv=adv: k[0] == "post-floor" and k[1] == adv)
        print(f"  post-floor adv={'ON ' if adv else 'OFF'}: {ok}/{n}" + (f" = {ok * 100 // n}%" if n else " (no data)"))


if __name__ == "__main__":
    main()

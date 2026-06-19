"""Repro-vote A/B readout — compares a baseline arm vs an experiment arm per-instance.

Readout philosophy (see test_ab_readout.py): the ONLY trustworthy cross-arm signal is
ground-truth resolved flips + whether the oracle's accept/reject verdict changed.
`*_false_red_rate` is deliberately NOT compared across arms (the vote arm doesn't emit
it → reads ~0 by non-observation, not improvement).

Usage:
  ab_readout.py --baseline <report.json|glob> --arm <report.json|glob>
Reports may be SWE-bench run reports (perInstance[]) — multiple files merged, latest
pass-state per instance wins.
"""
import argparse, glob, json


def _passed(r):
    return bool(r.get("passed"))


def _oracle_accepts(r):
    """Did the selection/repro oracle ACCEPT this instance's submitted patch?
    Prefer an explicit resolvedOracle/admissible signal; fall back to passed."""
    sel = r.get("selection") or {}
    for k in ("resolvedOracle", "admissible", "patchedResolved"):
        if k in sel and sel[k] is not None:
            return bool(sel[k])
    # no oracle field → approximate with grading outcome
    return _passed(r)


def _index(rows):
    """Latest row per instance id (later list position wins)."""
    out = {}
    for r in rows:
        iid = r.get("id")
        if iid:
            out[iid] = r
    return out


def compare(baseline_rows, arm_rows):
    b = _index(baseline_rows)
    a = _index(arm_rows)
    shared = [i for i in a if i in b]
    flips_to_pass, flips_to_fail, oracle_now_accepts = [], [], []
    for i in shared:
        if not _passed(b[i]) and _passed(a[i]):
            flips_to_pass.append(i)
        if _passed(b[i]) and not _passed(a[i]):
            flips_to_fail.append(i)
        if not _oracle_accepts(b[i]) and _oracle_accepts(a[i]):
            oracle_now_accepts.append(i)
    return {
        "compared": sorted(shared),
        "flips_to_pass": sorted(flips_to_pass),
        "flips_to_fail": sorted(flips_to_fail),
        "net_resolved_delta": len(flips_to_pass) - len(flips_to_fail),
        "oracle_now_accepts": sorted(oracle_now_accepts),
        "only_in_baseline": sorted(i for i in b if i not in a),
        "only_in_arm": sorted(i for i in a if i not in b),
    }


def _load(globpat):
    rows = []
    for f in sorted(glob.glob(globpat)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        rows.extend(d.get("perInstance", []))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True, help="report json or glob")
    ap.add_argument("--arm", required=True, help="report json or glob")
    a = ap.parse_args()
    r = compare(_load(a.baseline), _load(a.arm))
    print(f"compared {len(r['compared'])} instances")
    print(f"  net resolved Δ: {r['net_resolved_delta']:+d}")
    print(f"  FAIL→PASS flips : {r['flips_to_pass']}")
    print(f"  PASS→FAIL flips : {r['flips_to_fail']}  (regressions)")
    print(f"  oracle now-accepts (vote flipped verdict): {r['oracle_now_accepts']}")
    if r["only_in_baseline"] or r["only_in_arm"]:
        print(f"  (uncompared — only_in_baseline={r['only_in_baseline']} only_in_arm={r['only_in_arm']})")
    print("\nNOTE: false_red_rate intentionally NOT compared across arms (vote arm doesn't emit it).")


if __name__ == "__main__":
    main()

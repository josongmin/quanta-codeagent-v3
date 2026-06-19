#!/usr/bin/env python3
"""
Cold localization-accuracy scorer for SWE-bench bench runs.

The bottleneck for the ceiling set is LOCALIZATION (confirmed by the oracle-localize
A/B: handing sympy-17630 only the *where* flips FAIL->PASS). Full-solve grading
conflates localization with synthesis and is confounded by env (pyright/repro
death). This scores the localization step alone, decoupled from grading:

  for each instance: did the agent's patch touch the gold file(s)?
    - edited files (from model_patch)  vs  gold files (from gold patch)

Verdicts (per instance):
  EXACT      edited set == gold set
  HIT_ALL    every gold file edited (plus maybe extra, non-gold files)
  PARTIAL    some but not all gold files edited  (multi-site miss — e.g. sphinx-7462)
  MISS       zero gold files edited              (wrong-surface — e.g. sympy-17630)
  EMPTY      no patch produced

Key derived metric = WRONG-SURFACE RATE (MISS / total). The jun-17 execution-trace
plan gates P1 on exactly this: build the trace-localizer only if wrong-surface is high.

Optional --trajectory <file|glob>: best-effort extract of files the agent READ, to
split MISS into "never read gold file" (true localization miss) vs HIT_ALL-but-failed
into "read+edited, wrong content" (synthesis miss, NOT a localization problem).

Usage:
  localize_score.py --dataset verified-full.jsonl --preds A.jsonl [--label armA] \
                    [--preds B.jsonl --label armB] [--trajectory 'traj-*.jsonl'] [--json out.json]
Two --preds with two --label => prints the on/off localization delta.
"""
import argparse, glob, json, re, sys
from collections import Counter

FILE_RE = re.compile(r'^\+\+\+ b/(.+)$', re.M)           # post-image path in unified diff
DIFFGIT_RE = re.compile(r'^diff --git a/.+ b/(.+)$', re.M)

def files_from_patch(patch: str) -> set:
    if not patch:
        return set()
    files = set(m.group(1).strip() for m in FILE_RE.finditer(patch))
    if not files:  # fall back to the `diff --git` header
        files = set(m.group(1).strip() for m in DIFFGIT_RE.finditer(patch))
    # drop /dev/null (pure deletes) and test files are kept (gold sometimes edits tests)
    return {f for f in files if f and f != "dev/null"}

def load_gold(dataset_path: str) -> dict:
    gold = {}
    for line in open(dataset_path):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        gold[d["instance_id"]] = files_from_patch(d.get("patch", ""))
    return gold

def load_preds(preds_path: str) -> dict:
    out = {}
    for line in open(preds_path):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        iid = d.get("instance_id")
        patch = d.get("model_patch") or d.get("prediction") or d.get("patch") or ""
        out[iid] = files_from_patch(patch)
    return out

def read_files_from_trajectory(paths: str) -> set:
    """Best-effort: scan trajectory lines for .py paths mentioned with read/open/lsp
    tool activity. Trajectory format is not guaranteed JSONL, so be defensive."""
    read = set()
    py = re.compile(r'([\w./-]+\.py)')
    toolish = re.compile(r'(read|open|cat|lsp_|definition|references|grep|view|file)', re.I)
    for p in glob.glob(paths):
        try:
            for line in open(p, errors="ignore"):
                if toolish.search(line):
                    for m in py.finditer(line):
                        # normalize to repo-relative-ish (strip leading work-dir junk)
                        f = m.group(1)
                        f = re.sub(r'^.*?/repo-[\w]+/', '', f)
                        read.add(f)
        except Exception:
            continue
    return read

def verdict(edited: set, gold: set) -> str:
    if not edited:
        return "EMPTY"
    if not gold:
        return "??"  # dataset lacked gold (shouldn't happen)
    hit = edited & gold
    if edited == gold:
        return "EXACT"
    if gold <= edited:
        return "HIT_ALL"
    if hit:
        return "PARTIAL"
    return "MISS"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--preds", action="append", required=True)
    ap.add_argument("--label", action="append", default=[])
    ap.add_argument("--trajectory", default=None)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    gold = load_gold(a.dataset)
    labels = a.label + [f"arm{i}" for i in range(len(a.preds) - len(a.label))]
    read = read_files_from_trajectory(a.trajectory) if a.trajectory else set()

    arms = {}
    for preds_path, label in zip(a.preds, labels):
        preds = load_preds(preds_path)
        rows = []
        for iid, edited in preds.items():
            g = gold.get(iid, set())
            v = verdict(edited, g)
            missing = sorted(g - edited)       # gold files the agent never touched
            note = ""
            if read and missing:
                never_read = [f for f in missing if f not in read]
                note = ("never-read:" + ",".join(never_read)) if never_read else "read-but-not-edited"
            rows.append({"id": iid, "verdict": v, "edited": sorted(edited),
                         "gold": sorted(g), "missing": missing, "note": note})
        arms[label] = rows

    out = {"arms": {}}
    for label, rows in arms.items():
        c = Counter(r["verdict"] for r in rows)
        n = len(rows)
        wrong_surface = (c["MISS"] + c["EMPTY"]) / n if n else 0.0
        localized_ok = (c["EXACT"] + c["HIT_ALL"] + c["PARTIAL"]) / n if n else 0.0
        out["arms"][label] = {"n": n, "counts": dict(c),
                              "wrong_surface_rate": round(wrong_surface, 3),
                              "touched_a_gold_file_rate": round(localized_ok, 3),
                              "rows": rows}
        print(f"\n===== {label}  (n={n}) =====")
        print(f"  wrong-surface (MISS+EMPTY): {wrong_surface:.0%}   touched-a-gold-file: {localized_ok:.0%}")
        print(f"  verdicts: {dict(c)}")
        for r in sorted(rows, key=lambda x: x["verdict"]):
            line = f"  [{r['verdict']:7}] {r['id']}"
            if r["verdict"] not in ("EXACT", "HIT_ALL"):
                line += f"  edited={r['edited']} gold={r['gold']}"
                if r["note"]:
                    line += f"  ({r['note']})"
            print(line)

    if len(arms) == 2:
        (la, ra), (lb, rb) = list(arms.items())
        wa = out["arms"][la]["wrong_surface_rate"]; wb = out["arms"][lb]["wrong_surface_rate"]
        print(f"\n===== DELTA {la} vs {lb} =====")
        print(f"  wrong-surface: {la}={wa:.0%}  {lb}={wb:.0%}  Δ={wb-wa:+.0%}")

    if a.json:
        json.dump(out, open(a.json, "w"), indent=2)
        print(f"\nwrote {a.json}")

if __name__ == "__main__":
    main()

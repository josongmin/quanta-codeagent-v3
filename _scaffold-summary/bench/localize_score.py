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

HUNK_RE = re.compile(r'^@@ -(\d+)(?:,(\d+))?')          # old-side range header

def hunks_from_patch(patch: str) -> dict:
    """file -> [(old_start, old_end)] from each @@ -a,b @@ header (base-side lines)."""
    out: dict = {}
    cur = None
    for line in (patch or "").splitlines():
        m = FILE_RE.match(line)
        if m:
            cur = m.group(1).strip()
            out.setdefault(cur, [])
            continue
        h = HUNK_RE.match(line)
        if h and cur is not None:
            start = int(h.group(1))
            count = int(h.group(2)) if h.group(2) is not None else 1
            end = start + max(count, 1) - 1
            out[cur].append((start, end))
    return {f: r for f, r in out.items() if r}

def _overlap(a, b, pad: int) -> bool:
    return a[0] - pad <= b[1] and b[0] - pad <= a[1]

def verdict_line(our_patch: str, gold_patch: str, pad: int = 10) -> str:
    """EMPTY / MISS (wrong file) / MISS_INTRA (right file, disjoint lines) / HIT_LINE."""
    of = files_from_patch(our_patch)
    if not of:
        return "EMPTY"
    gh = hunks_from_patch(gold_patch)
    oh = hunks_from_patch(our_patch)
    shared = [f for f in gh if f in of]
    if not shared:
        return "MISS"
    for f in shared:
        for gr in gh[f]:
            for orr in oh.get(f, []):
                if _overlap(gr, orr, pad):
                    return "HIT_LINE"
    return "MISS_INTRA"

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

    gold = load_gold(a.dataset)                  # iid -> file set
    gold_patch = {d["instance_id"]: d["patch"]   # iid -> raw gold patch (for line-level)
                  for d in (json.loads(l) for l in open(a.dataset) if l.strip())}
    labels = a.label + [f"arm{i}" for i in range(len(a.preds) - len(a.label))]
    read = read_files_from_trajectory(a.trajectory) if a.trajectory else set()

    arms = {}
    for preds_path, label in zip(a.preds, labels):
        preds = load_preds(preds_path)                       # iid -> file set
        preds_patch = {}                                     # iid -> raw our patch
        for l in open(preds_path):
            if not l.strip():
                continue
            d = json.loads(l)
            if d.get("instance_id"):
                preds_patch[d["instance_id"]] = d.get("model_patch") or d.get("prediction") or d.get("patch") or ""
        rows = []
        for iid, edited in preds.items():
            g = gold.get(iid, set())
            v = verdict(edited, g)
            vl = verdict_line(preds_patch.get(iid, ""), gold_patch.get(iid, ""))  # line-level
            missing = sorted(g - edited)       # gold files the agent never touched
            note = ""
            if read and missing:
                never_read = [f for f in missing if f not in read]
                note = ("never-read:" + ",".join(never_read)) if never_read else "read-but-not-edited"
            rows.append({"id": iid, "verdict": v, "verdict_line": vl, "edited": sorted(edited),
                         "gold": sorted(g), "missing": missing, "note": note})
        arms[label] = rows

    out = {"arms": {}}
    for label, rows in arms.items():
        c = Counter(r["verdict"] for r in rows)
        cl = Counter(r["verdict_line"] for r in rows)
        n = len(rows)
        wrong_surface = (c["MISS"] + c["EMPTY"]) / n if n else 0.0
        localized_ok = (c["EXACT"] + c["HIT_ALL"] + c["PARTIAL"]) / n if n else 0.0
        # of patches that hit the right FILE, how many missed the right LINES (intra-file)?
        file_ok = cl["HIT_LINE"] + cl["MISS_INTRA"]
        intra_miss_rate = cl["MISS_INTRA"] / file_ok if file_ok else 0.0
        out["arms"][label] = {"n": n, "counts": dict(c), "counts_line": dict(cl),
                              "wrong_surface_rate": round(wrong_surface, 3),
                              "touched_a_gold_file_rate": round(localized_ok, 3),
                              "intra_file_miss_rate": round(intra_miss_rate, 3),
                              "rows": rows}
        print(f"\n===== {label}  (n={n}) =====")
        print(f"  wrong-surface (MISS+EMPTY): {wrong_surface:.0%}   touched-a-gold-file: {localized_ok:.0%}")
        print(f"  FILE verdicts: {dict(c)}")
        print(f"  LINE verdicts: {dict(cl)}   intra-file-miss (right file, wrong lines): {intra_miss_rate:.0%} of file-hits")
        print(f"  → of file-hits: HIT_LINE={cl['HIT_LINE']} = pure-synthesis-fail-or-pass | MISS_INTRA={cl['MISS_INTRA']} = intra-file localize miss")
        for r in sorted(rows, key=lambda x: (x["verdict_line"], x["verdict"])):
            line = f"  [{r['verdict']:7}/{r['verdict_line']:10}] {r['id']}"
            if r["verdict"] not in ("EXACT", "HIT_ALL") or r["verdict_line"] in ("MISS_INTRA",):
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

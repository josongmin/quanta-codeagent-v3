#!/usr/bin/env python3
"""Recompute the SWE-bench Verified union from vendored upstream results.json.

Source of truth = experiments-verified/results/*.json (134 public submissions).
Prints union solved / never-resolved (the dashboard's #=0 ceiling)."""
import json, glob, os

HERE = os.path.dirname(os.path.abspath(__file__))
files = glob.glob(os.path.join(HERE, "experiments-verified", "results", "*.json"))
union, all_ids = set(), set()
for fp in files:
    d = json.load(open(fp))
    for k in ("resolved", "unresolved", "no_generation", "no_logs",
              "with_logs", "generated", "error", "incomplete"):
        v = d.get(k)
        ids = list(v.keys()) if isinstance(v, dict) else (v or [])
        all_ids |= set(ids)
        if k == "resolved":
            union |= set(ids)
unsolved = sorted(all_ids - union)
print(f"submissions:        {len(files)}")
print(f"instance universe:  {len(all_ids)}")
print(f"union solved:       {len(union)}")
print(f"never-resolved:     {len(unsolved)}")
for u in unsolved:
    print("   ", u)

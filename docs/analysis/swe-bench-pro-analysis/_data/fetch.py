#!/usr/bin/env python3
"""Re-fetch SWE-bench Pro (ScaleAI/SWE-bench_Pro, test split) → _data/pro-full.jsonl.
Source: HF datasets-server rows API, paginated (731 rows). No `datasets` lib needed."""
import json, urllib.request, os
base = "https://datasets-server.huggingface.co/rows?dataset=ScaleAI%2FSWE-bench_Pro&config=default&split=test"
rows, off = [], 0
while True:
    with urllib.request.urlopen(f"{base}&offset={off}&length=100", timeout=40) as r:
        batch = json.load(r).get("rows", [])
    if not batch: break
    rows.extend(x["row"] for x in batch); off += 100
    if len(batch) < 100: break
out = os.path.join(os.path.dirname(__file__), "pro-full.jsonl")
with open(out, "w") as f:
    for r in rows: f.write(json.dumps(r) + "\n")
print(f"wrote {len(rows)} rows → {out}")

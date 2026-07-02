---
task: reshard-c4-data
category: data-science
difficulty: medium
tags: [coding, data-processing, file-operations]
expert_min: 30
junior_min: 60
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/reshard-c4-data:20251031
---

# reshard-c4-data

**Goal** — Write `/app/compress.py` (input_dir → output_dir) that reshards C4 JSONL data under constraints (≤30 files/dir, ≤15MB/file) and `/app/decompress.py` that losslessly reconstructs the exact original file structure/content in-place. Both must run via a `uv` venv + `pyproject.toml` (`uv sync` then `uv run`).

**Solution shape** — `solve.sh` heredocs two Python scripts. `compress.py`: globs `*.jsonl`, splits into pages, buffers ~15000 pages/shard, writes gzip'd `c4_reshard_NNNNN.jsonl.gz`, and emits `files_hashes.json` + `reverse_mapping.json` (page→origin-file provenance). `decompress.py`: reads the reverse-mapping, re-splits pages back to per-original-file outputs, restores trailing newline, deletes shards+metadata. Two files, ~130 lines total, uses gzip/json/hashlib/tqdm.

**Verifier** — pytest downloads an UNSEEN C4 shard (00009), splits to 10k mini-files, runs `uv sync` then `uv run compress` then deletes inputs, runs `uv run decompress`, and asserts: every shard ≤15MB, ≤30 items/dir, filename set matches originals, and sha256 of each recovered file equals original. Long (3600s timeout). reward 0/1.

**Difficulty drivers** — Lossless round-trip is the crux: byte-exact reconstruction (whitespace/trailing-newline handling) plus provenance tracking so multiplexed pages de-multiplex correctly. Real dep/env setup (uv venv, pyproject) that `uv sync` must satisfy with no extra installs. Generality across unseen shards. HuggingFace `datasets` download in the verifier is a runtime/latency risk.

**quanta attack points** — `container_exec` throughout: author scripts, run `uv sync`/`uv run` on the provided `c4_sample/`, diff round-tripped hashes. No interactivity. The exit-code loop helps a lot here — the agent can build its own compress→delete→decompress→hash harness mirroring the verifier and iterate. Main risk: newline/edge-of-shard off-by-one breaking hash equality, and forgetting the uv/pyproject packaging requirement.

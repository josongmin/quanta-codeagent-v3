---
task: multi-source-data-merger
category: data-processing
difficulty: medium
tags: [data-processing, etl, schema-mapping, conflict-resolution, pandas, parquet]
expert_min: 30
junior_min: 120
skill_class: DATA-WRANGLE
terminal_native: low
docker_image: alexgshaw/multi-source-data-merger:20251031
---

# multi-source-data-merger

**Goal** — Merge user records from three sources with different formats (JSON/CSV/Parquet) and differing field names into one Parquet file, resolving conflicts by source priority (a>b>c), and emit a conflict report JSON.

**Solution shape** — Single heredoc `python3` script using pandas. Reads the three files (`json.load`, `read_csv`, `read_parquet`), renames columns to a unified schema per source, maps boolean `is_active`/`active` to `active`/`inactive` strings, tags each row with `_source`/`_priority`, concats, iterates unique `user_id`s to detect per-field value disagreements (name/email/created_date) recording conflicts, then `sort_values('_priority').groupby('user_id').first()` to keep highest-priority record. Writes `/app/merged_users.parquet` + `/app/conflicts.json`. One script, ~130 lines.

**Verifier** — pytest (uvx w/ pandas+pyarrow). Checks output files exist; exact merged values for specific users (4 users {101..104}, name/email/created_date); conflict report has `total_conflicts>=1`, list length matches count, user 101 email conflict resolves to source_a value. reward 0/1.

**Difficulty drivers** — Schema mapping across 3 heterogeneous formats, priority-based conflict resolution logic, exact expected values (dates YYYY-MM-DD, user_id integer typing), correct conflict-report structure. No env difficulty; pandas is standard. Mostly careful spec-following.

**quanta attack points** — `container_exec` throughout: write script, run it, inspect the two output artifacts, iterate. Main failure risk is subtle schema/typing mismatch (integer user_id, date normalization) and the exact conflict-record shape — the exit-code "iterate until tests pass" loop helps a lot since output is a deterministic file the agent can diff against the spec. No interactive component; pty not needed.

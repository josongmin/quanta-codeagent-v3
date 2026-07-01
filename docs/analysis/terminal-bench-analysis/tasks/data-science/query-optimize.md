---
task: query-optimize
category: data-science
difficulty: medium
tags: [query-optimization, sql-query]
expert_min: 60
junior_min: 480
skill_class: DATA-WRANGLE
terminal_native: low
docker_image: alexgshaw/query-optimize:20251031
---

# query-optimize

**Goal** — Given the Open English Wordnet SQLite DB and a slow reference query (`/app/my-sql-query.sql`), write an optimized single SQLite query to `/app/sol.sql` that returns byte-identical results but runs at least as fast (median <= 1.05x golden).

**Solution shape** — `solve.sh` just `echo`s a hand-written optimized query into `/app/sol.sql` (a WITH/CTE using `word_stats` aggregation + `ROW_NUMBER() OVER (PARTITION BY ...)` window, HAVING filters, final join, ORDER BY, LIMIT 500). One SQL file, ~40 lines, no code execution in the solve script — the "solution" is the query text itself.

**Verifier** — pytest (uvx). Compares golden vs my-sql-query outputs (must be equal); asserts DB sha256 unchanged (no mutation allowed); times golden vs solution over 5 alternating iterations and requires solution median <= 1.05x golden; exact column-name/order + row-by-row equality of solution vs golden; enforces exactly one statement (single semicolon, starts SELECT/WITH), <=2000 chars, valid via EXPLAIN QUERY PLAN. reward 0/1.

**Difficulty drivers** — SQL query-plan reasoning: must understand the golden query semantics, rewrite for speed while preserving exact ordered output, respect single-statement + no-DB-mutation constraints (anti-reward-hack). Domain is SQLite optimizer behavior (indexes, window functions). Hard for juniors (480 min) — needs EXPLAIN QUERY PLAN literacy.

**quanta attack points** — `container_exec` to run `sqlite3` with EXPLAIN QUERY PLAN, time candidate queries, and diff output against golden. Main risk: producing a faster query whose ordering/columns drift from golden (row-by-row exact match), or accidentally multi-statement. The exit-code loop helps for correctness checking but the perf threshold is timing-sensitive — the agent must self-benchmark, not just pass a boolean. No interactive TUI; pty unnecessary.

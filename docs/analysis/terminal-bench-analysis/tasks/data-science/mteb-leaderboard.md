---
task: mteb-leaderboard
category: data-science
difficulty: medium
tags: [retrieval, mteb]
expert_min: 5
junior_min: 10
skill_class: DATA-WRANGLE
terminal_native: med
docker_image: alexgshaw/mteb-leaderboard:20251031
---

# mteb-leaderboard

**Goal** — Find the best embedding model (highest Mean(Task)) on the Scandinavian MTEB leaderboard as of Aug 2025 and write its `org/model_name` to `/app/result.txt`. Expected answer: `GritLM/GritLM-7B`.

**Solution shape** — Tiny (~50 line) bash: `git clone` the `embeddings-benchmark/results` repo, `git checkout` a commit dated within August 2025 (pins the leaderboard snapshot), then a heredoc `leaderboard.py` that uses the `mteb` library — `get_benchmark("MTEB(Scandinavian, v1)")`, filter models that have all tasks, `load_results(...).to_dataframe()`, drop NaN columns, take the highest mean, write the winner. Essentially a research/lookup task, not app-authoring.

**Verifier** — pytest: `/app/result.txt` exists, is exactly one line, and equals `GritLM/GritLM-7B`.

**Difficulty drivers** — Not code complexity: it's knowing MTEB's data layout, the `mteb` API, and the time-travel trick (checkout an Aug-2025 commit so the ranking is reproducible/uncontaminated). Junior est. only 10 min. The single-string exact match is the whole gate — pick the wrong benchmark variant or date and it fails.

**quanta attack points** — `container_exec` throughout (clone, checkout, run python); no interactivity. Main risk: choosing the wrong benchmark slug/date or fetching the live leaderboard instead of the pinned snapshot, yielding a different top model. The iterate-until-pass loop is weak leverage here — the test reveals only pass/fail on one string, giving little signal to converge; correctness hinges on domain knowledge up front.

---
task: merge-diff-arc-agi-task
category: debugging
difficulty: medium
tags: [git, coding]
expert_min: 20
junior_min: 40
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/merge-diff-arc-agi-task:20251031
---

# merge-diff-arc-agi-task

**Goal** — Init a git repo at `/app/repo`, fetch two git bundles (`bundle1.bundle`, `bundle2.bundle`) into local branches `branch1`/`branch2`, merge them with conflict resolution so `/app/repo/algo.py` exists, and author `map(grid)` implementing the input→output mapping inferred from ARC-AGI examples in `/app/examples.json` (must generalize to hidden inputs).

**Solution shape** — Bash. Installs git, `git init` + config, seed commit, `git fetch /app/bundleN.bundle HEAD:branchN` for both. Then checks out `main` from branch1 and `git reset --hard branch2` (i.e. takes branch2's tree wholesale rather than a true 3-way merge), and writes `algo.py`. The reference `map` is a compact ARC transform: builds a dict keyed by `(i+j)%3` → nonzero cell, then rebuilds the grid mapping each `(i+j)%3` back to that value (an anti-diagonal color-fill pattern). Commits. Two files touched: git state + algo.py (~15 lines).

**Verifier** — pytest: `.git` exists; `git branch -a` shows both `branch1` and `branch2`; `algo.py` exists, imports, has callable `map`; and `map` reproduces every example in a private `/tests/test.json` element-by-element (generalization check on hidden inputs). reward binary 0/1.

**Difficulty drivers** — Two-part: (1) git-bundle mechanics — fetching `HEAD:branchN`, handling ambiguous refs, ensuring both named branches survive the merge; (2) the real ARC-AGI inductive puzzle — inferring the `(i+j)%3` mapping rule from a handful of examples such that it generalizes to hidden grids. The puzzle is the hard part, not the git.

**quanta attack points** — `container_exec` throughout; git and python-import checks are all exit-code observable, so the "iterate until tests pass" loop drives the git/branch requirements well. The generalization check on hidden inputs is the risk: the agent can pass visible `examples.json` with an overfit rule yet fail `/tests/test.json`. No TUI needed — no `pty_*`.

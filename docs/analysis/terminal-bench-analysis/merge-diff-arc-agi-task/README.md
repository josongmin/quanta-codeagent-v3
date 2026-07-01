# merge-diff-arc-agi-task

**Goal:** Init a git repo at `/app/repo`, fetch two git bundles into `branch1`/`branch2`, merge branch2 into branch1, and produce `/app/repo/algo.py` with a `map(grid)` function that reproduces the ARC-AGI-style input→output transform defined implicitly by `/app/examples.json` (must generalize to hidden test inputs).

## Our result
| Model | Reward | Notes |
|-------|--------|-------|
| quanta + gpt-5.4 | 0 (fail) | wrong `map` transform |
| quanta + gpt-5.5 | 1 (pass) | solved (heavy: 556k in / 16k out tokens) |

**gpt-5.4 failure (concrete):** git/branch/algo-exists/map-callable tests passed, but `test_algo_map_function_with_test_input` failed: `Example 3, position (0,0): Expected 2, got 4`. So 5.4 wired up the git merge fine but inferred the *wrong* grid-mapping rule from the examples. gpt-5.5 spent ~5x the tokens and found the correct generalizing rule.

## Reference approach
`solve.sh` is the genuine solution but note: the git plumbing it shows (fetch both bundles, `checkout -b main branch1`, then `git reset --hard branch2`) discards branch1's tree rather than truly conflict-merging — it satisfies the "both branches exist" checks and then hand-writes the answer. The real payload is the hand-authored `algo.py`: a diagonal-constant map where cell value depends only on `(i+j) % 3` — it collects the non-zero color seen on each anti-diagonal residue class `(i+j)%3` and repaints every cell of that class with it (`d[(i+j)%3]=c` for nonzero c; output `d.get((i+j)%3,0)`). The transform is the solution, not the merge.

## Public leaderboard
tb-2-specific; public per-model trajectories are on the tbench.ai Terminal-Bench 2.0/2.1 leaderboard (not bulk-downloadable here). https://www.tbench.ai/leaderboard/terminal-bench/2.0

## Verifier
`tests/test_outputs.py` checks `.git` exists, both `branch1`/`branch2` present, `algo.py` exists with a callable `map`, and that `map` reproduces every input→output pair in the hidden `/tests/test.json` exactly, element by element. Reward is binary 0/1.

# largest-eigenval

**Goal:** Implement `find_dominant_eigenvalue_and_eigenvector` in `/app/eigen.py` (dominant = largest magnitude, matrices up to 10x10, possibly non-symmetric/complex) that satisfies `A @ v == λ v` AND runs *faster than* numpy's `np.linalg.eig` reference (median time per call).

## Our result
| Model | Reward | Notes |
|-------|--------|-------|
| quanta + gpt-5.4 | 0 (fail) | correct but too slow |
| quanta + gpt-5.5 | 0 (fail) | also failed |

**gpt-5.4 failure (concrete):** correctness passed (`test_eigen_pair`, `test_dominance_eigenvalue`) but `test_speedup` failed on every size — our impl was ~1.5–3x *slower* than the numpy reference. Sample assertions: `0.000092 s/call > 0.000052 s/call` (~1.76x too slow), `0.000101 > 0.000033` (~3.1x), `0.000213 > 0.000100` (~2.1x). Both models failed; this is a genuinely hard "beat numpy at its own game" task — the reference solution wins only by swapping in a faster native eigensolver.

## Reference approach
`solve.sh` is the genuine solution: `pip install eigenpy==3.10.3`, then rewrite `eigen.py` to call C++ Eigen's `eigenpy.EigenSolver` (faster than numpy's LAPACK `eig` path for these tiny matrices), returning the max-magnitude eigenpair. The win comes from the faster native solver + dependency install, not from algorithm cleverness.

## Public leaderboard
tb-2-specific; public per-model trajectories are on the tbench.ai Terminal-Bench 2.0/2.1 leaderboard (not bulk-downloadable here). https://www.tbench.ai/leaderboard/terminal-bench/2.0

## Verifier
`tests/test_outputs.py` (sizes 2–10): checks the eigenpair satisfies `A@v≈λv`, that `|λ|` is the max magnitude, and — in an isolated process, N=100, median time — that the candidate is strictly faster than `np.linalg.eig`. Reward is binary 0/1 (all three must pass).

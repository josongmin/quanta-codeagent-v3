# log-summary-date-ranges

**Goal:** Parse dated log files in `/app/logs` (`YYYY-MM-DD_<source>.log`) and write `/app/summary.csv` counting ERROR/WARNING/INFO per date range (today, last 7d, last 30d, month-to-date, total), reference date `2025-08-12`.

## Our result
| Model | Reward | Notes |
|-------|--------|-------|
| quanta + gpt-5.4 | 1 (pass) | solved |
| quanta + gpt-5.5 | 1 (pass) | solved |

Both models passed. No failure detail to report.

## Reference approach
`solve.sh` is the genuine solution. For each period it converts filename dates to Unix timestamps via `date -d`, filters files whose date falls in `[start,end]`, and sums `grep -c "\[SEVERITY\]"` across matching files. Period starts are computed with `date -d "$CURRENT_DATE -6/-29 days"` and month-start from the `YYYY-MM` prefix; `total` uses a plain recursive grep.

## Public leaderboard
tb-2-specific; public per-model trajectories are on the tbench.ai Terminal-Bench 2.0/2.1 leaderboard (not bulk-downloadable here). https://www.tbench.ai/leaderboard/terminal-bench/2.0

## Verifier
`tests/test_outputs.py` checks the CSV exists, has header `period,severity,count`, and that all 15 rows exactly equal hard-coded expected counts. Reward is binary 0/1.

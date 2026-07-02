# winning-avg-corewars

**Goal:** Write a CoreWars warrior (`/app/my_warrior.red`, redcode, core 8000 / 80000 cycles) that beats five classic opponents in pMARS batch mode: ≥75% win rate vs stone, vampire, paper; ≥33% vs snake, g2-clear.

## Our result
| Model | Reward | Notes |
|-------|--------|-------|
| quanta + gpt-5.4 | 0 (fail) | passed 4/5 opponents, lost to stone |
| quanta + gpt-5.5 | ? (incomplete) | run did not finish — no reward recorded |

**gpt-5.4 failure (concrete):** `Only achieved 56% win rate vs stone.red (need 75%+)`. Full board: stone 56% FAIL, vampire 78% PASS, paper 89% PASS, snake 36% PASS, g2-clear 40% PASS → 4/5 thresholds met, single miss on stone sinks the whole (binary) reward. Close but under. gpt-5.5's run did not complete, so its outcome is unknown ("?").

## Reference approach
`solve.sh` is the genuine solution and hand-writes a `;redcode-94` multi-component warrior ("MultiTarget"): an `spl`-fanned collection of a stone bomber, a Rosebud-killer stone/imp hybrid, a dedicated snake neutralizer, a binary-tree imp launcher, and a Stargate-style clear loop — a portfolio tuned to clear all five thresholds simultaneously (strategies credited to corewar.co.uk).

## Public leaderboard
tb-2-specific; public per-model trajectories are on the tbench.ai Terminal-Bench 2.0/2.1 leaderboard (not bulk-downloadable here). https://www.tbench.ai/leaderboard/terminal-bench/2.0

## Verifier
`tests/test_outputs.py` checks the 5 opponents' SHA256 are unmodified, `my_warrior.red` exists, then runs `pmars -b -r 100` vs each opponent and asserts each win count meets its per-opponent threshold (75/75/75/33/33). Reward is binary 0/1 (all five must clear).

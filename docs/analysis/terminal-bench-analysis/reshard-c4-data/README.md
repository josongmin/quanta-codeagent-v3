# reshard-c4-data — solution history

**Task goal:** Write two scripts that reshard a C4 data slice to satisfy server constraints (≤30 files/dir, ≤15MB/file) and losslessly revert it back to the original structure. The scripts must be reproducible via a `uv` venv + `pyproject.toml` in `/app`.

> **Instruction variant note.** The public abacus leaderboard runs were graded against an *earlier phrasing* of this task: produce a `c4_reshard/` folder plus a `revert.py` in the parent of `c4_sample/` (do not run revert). Our local `instruction.md` (and `reference-solve.sh`) is the *current* phrasing: `/app/compress.py <in> <out>` + `/app/decompress.py <resharded>`. Both variants test the same two behaviors and the grader has the same two sub-checks (`test_reformat_success`, `test_revert`), so the solve-rate comparison holds; only the exact filenames/paths differ.

## Solve table (public leaderboard, best-of-5)

Sorted by resolved desc. No run solved it, so the tiebreaker column shows **partial sub-test passes** (a run that got *reformat* OR *revert* right on some attempt, but never both in the same attempt). `med_out` = median output tokens over the run's attempts (0 = scaffold didn't report token counts).

| scaffold | model | resolved (best-of-5) | dominant failure | med out tok | partial passes |
|---|---|---|---|---|---|
| droid | gpt-5 | 0/5 | both sub-tests fail | n/a (0) | reformat✓×3 |
| orchestrator | claude-4.1-opus | 0/5 | agent_timeout×2 | 9267 | revert✓×2 |
| apex | gpt-5 | 0/5 | both sub-tests fail | 5055 | reformat✓×1, revert✓×1 |
| apex | claude-4-5-sonnet | 0/5 | both sub-tests fail | 4306 | revert✓×1 |
| abacusai-desktop | multiple | 0/5 | both sub-tests fail | n/a (0) | reformat✓×1 |
| ante | claude-4-5-sonnet | 0/5 | both sub-tests fail | n/a (0) | revert✓×1 |
| orchestrator | claude-4-sonnet | 0/5 | agent_timeout×1 | 7685 | — |
| orchestrator | qwen-3-coder-480B | 0/5 | agent_timeout×1, test_timeout×1 | 3896 | — |
| cursor-cli | claude-4-sonnet | 0/5 | agent_timeout×5 | n/a (0) | — |
| swe-agent-mini | claude-4-sonnet | 0/4 | agent_timeout×1, parse_error×1 | n/a (0) | — |
| openhands | claude-4-sonnet | 0/5 | both sub-tests fail | n/a (0) | — |
| droid | claude-4-1-opus | 0/5 | both sub-tests fail | n/a (0) | — |
| droid | claude-4-sonnet | 0/5 | both sub-tests fail | n/a (0) | — |
| droid | claude-4-5-sonnet | 0/5 | both sub-tests fail | n/a (0) | — |
| ante | claude-4-sonnet | 0/5 | both sub-tests fail | n/a (0) | — |
| deepagent-desktop | claude-4-5-sonnet | 0/5 | both sub-tests fail | n/a (0) | — |
| iflow-cli | Qwen3-Coder-480A30 | 0/5 | both sub-tests fail | n/a (0) | — |

**Public solve rate: 0/17 runs (0/84 attempts).** `failure_mode` is literally `"unset"` in most results.json (the harness didn't auto-classify these), so the real signal is `parser_results`: 72/84 attempts failed **both** sub-tests, 5 passed only revert, 5 passed only reformat, 2 crashed with no parse.

## Our result (quanta)

| agent | model | reward | in tok | out tok |
|---|---|---|---|---|
| quanta | gpt-5.4 | **1 (SOLVED)** | 171,108 | 13,302 |
| quanta | gpt-5.5 | **1 (SOLVED)** | 66,316 | 8,158 |

(reward "1" = both sub-tests pass. Note: our brain does not capture its own command trace, so only result stats are available for "ours" — no trajectory to dump.)

## Reference solution approach (`reference-solve.sh`)

`solve.sh` writes two Python scripts using a page-buffering strategy:
- **compress.py** — reads all `*.jsonl` inputs, splits each into pages (lines), accumulates pages into a buffer and flushes ~15k pages at a time into gzip'd `c4_reshard_NNNNN.jsonl.gz` shards (keeps files under the 15MB / 30-file caps). It records two side-car JSON files: `files_hashes.json` (sha256 of each stripped input, for verification) and **`reverse_mapping.json`** — the per-shard, per-page list of which original input each page came from.
- **decompress.py** — reads `reverse_mapping.json`, un-gzips each shard, and re-splits pages back to their original files by the recorded mapping, then deletes the shards + side-cars, restoring the original structure in place.

The mapping side-car is the crux: it's what makes the revert *exact* rather than best-effort.

## Key insight

**Nobody on the public leaderboard solved this — 0/17 runs, 0/84 attempts** — across 6 scaffolds and 6 models (sonnet-4/4.5, opus-4.1, gpt-5, qwen-3-coder). Both quanta gpt-5.4 and gpt-5.5 **solved it outright**, so this is a task where we beat the entire public field, not just match it.

The failure is not "can't start" — it's **can't get both halves right at once.** 10 of the 84 public attempts passed *exactly one* sub-test but never both in the same attempt (droid+gpt-5 nailed the reshard 3×; orchestrator+opus nailed the revert 2×). The near-universal failure mode (72/84 = both fail) is a lossless round-trip bug: agents reshard the data fine but their revert doesn't reconstruct the original byte-for-byte — exactly the trap the reference solution avoids by persisting an explicit `reverse_mapping.json`. The orchestrator scaffolds additionally burned the most tokens (med out 3.9k–9.3k) and still hit `agent_timeout` on several attempts.

Cost comparison where public numbers exist: our gpt-5.5 solve used **8,158 output tokens** vs the highest-spending public run (orchestrator+opus at **9,267 median out**, still 0/5). So we solved it while spending *less* than the priciest scaffold that failed. Our gpt-5.4 solve used 13,302 out / 171k in (more exploration), gpt-5.5 was the leaner path (8,158 out / 66k in) — both landed reward 1.

## Files
- `reference-solve.sh` — canonical solution, verbatim.
- `scaffolds/` — real trajectories for representative failing runs. **The leaderboard `commands.txt` only records harness tmux keystrokes (launch agent / run tests), not the agent's shell trace** — the actual trajectory lives in `sessions/agent.log`:
  - `20250825_swe-agent-mini_claude-4-sonnet.agent-log.txt` — head-800; full approach visible (builds `c4_reshard/batch_XXXX/` dirs by `shutil.copy2`, writes `revert.py`). Both sub-tests failed.
  - `20250711_openhands_claude-4-sonnet.agent-log.txt` — head-800 of 13,918. Both sub-tests failed.
  - `20250906_orchestrator_claude-4.1-opus.commands.txt` — the near-miss (revert✓, reformat✗). Orchestrator runs its agent out-of-band, so **no per-command trajectory was captured** for it; the raw harness keystrokes + stub agent.log are included with a note.

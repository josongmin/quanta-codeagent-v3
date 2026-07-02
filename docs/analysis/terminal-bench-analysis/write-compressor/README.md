# Terminal-Bench task: `write-compressor` — solution history

**Task goal (1 line):** Reverse-engineer the entropy format of a given range-coder decompressor (`/app/decomp.c`) and hand-write a `data.comp` (≤ 2500 bytes) such that `cat data.comp | ./decomp` reproduces `/app/data.txt` byte-for-byte.

- Author: Nicholas Carlini. Difficulty: `hard`. Category: software-engineering.
- Time estimates in `task.toml`: **expert 1440 min (~24h), junior 4800 min (~80h)**.
- Agent budget: `agent.timeout_sec = 900` (15 min wall). This is the crux — see Key insight.
- `decomp.c` is an arithmetic/range coder: `radix=255`, bit-level `get_bit(ctx)` with per-context adaptive probabilities, LZ-style Lit/Add/Match tokens. To emit a legal `data.comp` the agent must reconstruct the *exact* encoder that is the inverse of this decoder.

## The story: public leaderboard 0/17, quanta+gpt-5.5 = solved

Every public leaderboard scaffold failed this task. Our quanta harness on gpt-5.5 solved it. Read the caveat before over-reading the scaffold angle.

### Solve table — public leaderboard (all data from `/tmp/tb-abacus/results/.../write-compressor/results.json`)

17 scaffold×model configs, 5 runs each = **85 runs, 0 resolved.** `resolved` column is best-of-5.

| scaffold | model | resolved (best-of-5) | dominant failure_mode | median out-tokens | commands.txt? |
|---|---|---|---|---|---|
| openhands | claude-4-sonnet | 0/5 | agent_timeout | n/a* | yes (+full agent.log) |
| cursor-cli | claude-4-sonnet | 0/5 | agent_timeout / unset | n/a* | no |
| swe-agent-mini | claude-4-sonnet | 0/5 | test_timeout / unset | n/a* | yes |
| orchestrator | claude-4-sonnet | 0/5 | agent_timeout | n/a* | yes (harness-only) |
| orchestrator | qwen-3-coder-480B | 0/5 | agent_timeout | n/a* | yes (harness-only) |
| orchestrator | claude-4.1-opus | 0/5 | agent_timeout | n/a* | yes (harness-only) |
| droid | claude-4-1-opus | 0/5 | agent_timeout | n/a* | no |
| droid | claude-4-sonnet | 0/5 | agent_timeout | n/a* | no |
| droid | gpt-5 | 0/5 | agent_timeout | n/a* | no |
| droid | claude-4-5-sonnet | 0/5 | agent_timeout | n/a* | no |
| ante | claude-4-sonnet | 0/5 | agent_timeout | n/a* | no |
| ante | claude-4-5-sonnet | 0/5 | agent_timeout / parse_error | n/a* | no |
| apex_agent | gpt-5 | 0/5 | agent_timeout | n/a* | no |
| apex_agent | claude-4-5-sonnet | 0/5 | agent_timeout | n/a* | no |
| deepagent-desktop | claude-4-5-sonnet | 0/5 | agent_timeout | n/a* | no |
| iflow-cli | Qwen3-Coder-480A30 | 0/5 | unset | n/a* | no |
| abacusai-desktop | multiple | 0/5 | agent_timeout | n/a* | no |

`* median out-tokens = n/a`: the public result dumps carry `total_output_tokens` as `null` or `0` for **every** write-compressor run — token accounting was not exported in this artifact set. So we cannot report a public-side token count; only verdicts and timings are trustworthy.

**Failure-mode tally across all 85 public runs:** `agent_timeout` 72, `unset` 11, `test_timeout` 1, `parse_error` 1. So the dominant mode is unambiguously **agent_timeout** — agents burn the whole 900 s wall and never converge on a valid encoder. Agent-duration evidence: droid/apex/deepagent/abacusai frontier runs sit pinned at ~660 s (the harness-clamped ceiling) on essentially every run; the cheaper scaffolds (swe-agent-mini ~56–190 s, iflow ~240–297 s) exit early with an invalid/empty artifact (`unset`/`test_timeout`) rather than timing out, but still resolve 0/5.

### Our row — quanta (source: `/tmp/our-tb-results.json` → `write-compressor`)

| scaffold | model | reward | input tokens | output tokens |
|---|---|---|---|---|
| quanta | gpt-5.4 | **0** | 164,319 | 6,172 |
| quanta | **gpt-5.5** | **✅ 1** | 272,068 | **18,439** |

gpt-5.4 under our own harness also failed (reward 0) — so this is *not* "quanta always wins." Only gpt-5.5 solved it, and it did so with heavy iteration: ~18.4k output tokens (3× the gpt-5.4 attempt), consistent with many encoder-rewrite/verify cycles inside the 15-min window.

### Reference approach (`reference-solve.sh`, copied verbatim)

`solve.sh` writes a ~600-line **Rust encoder (`main.rs`)** that is the hand-built inverse of `decomp.c`:
- Mirrors the decoder's range-coder exactly: `RADIX=255`, per-context adaptive bit model, the same context numbering (`CTX_LIT`, `CTX_OFFSET`, `CTX_LEN`, `CTX_HEADER`, `CTX_SIGN`, `CTX_ADD_POS/DELTA`, …) and offsets (`OFF1=5`, `OFF2=2`, `LITSIZE=4`).
- Tokenizes `data.txt` into `Lit / Add(pos,delta) / Match(offset,length)` tokens (LZ-style), then uses a **DP over a `FakeRangeEncoder`** (log2 cost estimator) to pick the token sequence that minimizes encoded size under the ≤ 2500-byte cap.
- Emits `data.comp` by running the real range encoder over the chosen tokens.

This is exactly the ~24h expert task the `task.toml` estimate describes: fully reconstruct the coder's probability model and search token space under a hard size budget.

## Key insight (honest framing)

The public leaderboard is **0/17 (0/85 runs), essentially all `agent_timeout`** — including frontier Anthropic (claude-4.1-opus, claude-4-5-sonnet) and gpt-5 under strong scaffolds (droid, apex, deepagent, orchestrator). This is a ~24h-expert reverse-engineering problem crammed into a 15-min agent budget, so timing out is the expected outcome. Yet **quanta + gpt-5.5 solved it in a single attempt** with heavy iteration (18.4k output tokens).

**But be clear on causation — this is largely a model-generation effect, not proof our scaffold beat theirs:**
- **gpt-5.5 is newer than every model on the leaderboard.** The public set tops out at claude-4.x / gpt-5 (dated 2025-07 … 2025-11); gpt-5.5 post-dates all of them. A more capable base model on a task this reasoning-heavy is the most parsimonious explanation.
- **Within our own harness, gpt-5.4 also failed (reward 0).** Same scaffold, older model, no solve. The delta that flipped 0→1 is the model, not a scaffold change.
- **Task version is verified identical.** The instruction embedded in every public `results.json` references the same `/app/decomp.c` range-coder with the same 2500-byte cap as our `terminal-bench/write-compressor/instruction.md` — same task, not an easier variant. (The public dumps don't ship `decomp.c` itself, so identity is established via the verbatim instruction text, not a byte-diff of the decoder.)

**Net:** quanta + gpt-5.5 sits at or above the frontier on this task — there is **no evidence of a scaffold gap in our favor** here. The right reading is "our newest model clears a task the older-model field could not," with the scaffold at most a contributing factor. No claim that quanta's harness out-scaffolds droid/apex/openhands on equal-model footing can be made from this single data point.

## Caveats on the artifacts (what the data actually contains)

- **No public token counts.** `total_output_tokens` is null/0 for all 85 public runs — median-out-tokens is genuinely unavailable, not omitted.
- **`commands.txt` is harness-level, not agent-level.** Only 4 of 17 groups shipped a `commands.txt`, and its contents are the **tmux orchestration** (`asciinema rec`, `source install-agent.sh`, the single agent-launch line, `run-tests.sh`) — *not* the agent's internal command trace. The droid / apex / ante / deepagent / cursor / iflow / abacusai groups (including every claude-4-5-sonnet frontier run) shipped **only `results.json`** — a verdict + timings, no trace. So the requested trio "orchestrator / droid / frontier-4.5-sonnet commands.txt" is not fully realizable: droid and 4.5-sonnet groups have no commands.txt to dump.
- The **openhands** run is the one exception with a real, full terminal `agent.log` (~13–15k lines) capturing the model actually inspecting `decomp.c` before timing out; that log is left in place under the source tree (path noted in `scaffolds/openhands_claude-4-sonnet.commands.txt`) rather than copied, as it is mostly apt-install/terminal noise.
- **Our brain does not record its command trace.** For quanta we have only result stats (reward + token totals), not the step-by-step commands gpt-5.5 ran.

## Files

- `README.md` — this file.
- `reference-solve.sh` — verbatim copy of the official `solve.sh` (Rust range-encoder + DP).
- `scaffolds/orchestrator_claude-4.1-opus.commands.txt` — frontier Anthropic under the orchestrator harness (harness-level tmux only; agent ran headless).
- `scaffolds/openhands_claude-4-sonnet.commands.txt` — openhands launch line; a full `agent.log` trace exists alongside the source result (see note in file).
- `scaffolds/swe-agent-mini_claude-4-sonnet.commands.txt` — minimal single-shot scaffold (`mini -m anthropic/claude-sonnet-4 …`).

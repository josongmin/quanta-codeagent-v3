# Terminal-Bench task: `pytorch-model-cli` — solution history

**Task goal:** Implement a C command-line tool (`./cli_tool weights.json image.png`) that runs a pre-trained MNIST model (given as a PyTorch `.pth` state_dict + `model.py`) on a 28×28 grayscale PNG and prints only the predicted digit; final artifacts must be `/app/cli_tool` (binary), `/app/weights.json`, `/app/prediction.txt`.

## Solve table (public leaderboard, sorted resolved desc)

Only **3** scaffold×model runs attempted this task in the local `tb-abacus` corpus (all use the same `orchestrator` scaffold; they differ by model). The "~17" in the brief is the leaderboard's total task count, not runs of this task. Each run = best-of-5.

| scaffold | model | resolved best-of-5 | failure_mode | median out-tokens |
|---|---|---|---|---|
| orchestrator | claude-4-sonnet | **5/5** | agent_timeout† | n/a‡ |
| orchestrator | claude-4.1-opus | **4/5** | agent_timeout† | n/a‡ |
| orchestrator | qwen-3-coder-480B | **0/5** | agent_timeout† | n/a‡ |
| **ours (quanta)** | **gpt-5.4** | **1/1 (solved)** | — | out=4794 (in=148943) |
| **ours (quanta)** | **gpt-5.5** | **1/1 (solved)** | — | out=3797 (in=84335) |

† `failure_mode: agent_timeout` is stamped on nearly every attempt including the resolved ones — the orchestrator agent exhausts its wall-clock budget, but the harness still grades whatever artifacts were left in `/app`. So "resolved + agent_timeout" means "finished in time to leave a working solution, then kept going until the timer expired." It is not a real failure signal here.

‡ Token counts are `null` in every orchestrator `results.json` (`total_input_tokens`/`total_output_tokens` not reported by that scaffold; the only non-null value in the whole corpus is a degenerate `out=7` on qwen attempt-5 which produced nothing). Our brain reports real token stats (shown above) but does not capture a command trace.

**Overall: 2 of 3 leaderboard runs solve it (sonnet 5/5, opus 4/5); qwen 0/5. Ours solves it on both gpt-5.4 and gpt-5.5.**

### Per-attempt detail (the useful signal, since best-of-5 hides it)

| model | a1 | a2 | a3 | a4 | a5 | how failures failed |
|---|---|---|---|---|---|---|
| sonnet | 6/6 ✅ | 6/6 ✅ | 6/6 ✅ | 6/6 ✅ | 6/6 ✅ | — |
| opus | 6/6 ✅ | 6/6 ✅ | 6/6 ✅ | **4/6 ❌** | 6/6 ✅ | a4: binary built & runs, but `weights.json` schema mismatch |
| qwen | 1/6 ❌ | 1/6 ❌ | 0/6 ❌ | 1/6 ❌ | 0/6 ❌ | never built the `cli_tool` binary at all |

The 6 tests: `test_weights_file_exists`, `test_cli_tool_exists`, `test_prediction_file_exists`, `test_prediction_file_content`, `test_cli_tool_executable` (asserts output `== "2"` on `image.png`), `test_cli_tool_output` (runs binary on 50 MNIST images).

## Reference approach (`solution/solve.sh` → copied to `reference-solve.sh`)

The gold solution is a **two-artifact pipeline** whose halves must agree on a contract:

1. **Inspect** — `cat model.py`, then a `peek_weights.py` that `torch.load`s `model.pth` and prints every `state_dict` key + tensor shape. This is how you learn the layer names (`input_layer`, `hidden_layer`, `output_layer`) and dims (784→16→16→10).
2. **Convert (Python side)** — `convert.py` flattens each weight/bias tensor to a flat Python list and dumps a **fixed 6-key JSON** (`w1,b1,w2,b2,w3,b3`) to `weights.json`.
3. **Reader + inference (C side)** — `cli_tool.c` reads exactly those 6 keys via cJSON with hard-coded expected sizes (`HIDDEN_DIM*INPUT_DIM`, etc.), decodes the PNG via lodepng to a 784-float `[0,1]` input, runs 3 `linear` layers with ReLU between them, and `argmax`es the 10 logits.
4. **Build** — rename `lodepng.cpp`→`.c`, `apt-get install build-essential`, `gcc -o cli_tool cli_tool.c cJSON.c lodepng.c -lm`.
5. **Emit** — `./cli_tool weights.json image.png > prediction.txt`.

The whole difficulty is that **the JSON schema written by step 2 and the schema expected by step 3 are an implicit contract the agent invents itself** — nothing tells it the key names or that dims are hard-coded vs. carried in the JSON.

## Key insight — WHO solved it and HOW the winner differs from the losers

**Who solved it:** the `orchestrator` scaffold on strong models — sonnet (5/5, flawless) and opus (4/5). qwen-3-coder-480B failed all 5.

**Important caveat on evidence:** the orchestrator scaffold does **not** record the agent's actual commands. `commands.txt` and `agent.cast` contain only the harness wrapper (asciinema-rec → `run-tests.sh`); the agent works out-of-band, visible only as a 532 s (sonnet) / 713 s (qwen) blank gap in `agent.cast` before `exit`. So the winning-vs-losing trajectory is **reconstructed from `sessions/tests.log`** — i.e. from the artifacts each agent left in `/app` and the exact assertion each test threw. The `scaffolds/*.commands.txt` dumps carry that reconstructed test-outcome evidence appended after the (identical) wrapper.

The three outcomes form a clean ladder of how far each agent got through the two-artifact pipeline:

- **Winners (sonnet all 5, opus 4 of 5): completed BOTH halves and made them agree.** They inspected the state_dict, wrote a `convert.py` whose JSON schema exactly matched a `cli_tool.c` reader they also wrote, compiled it, and ran it — all six tests pass, including `test_cli_tool_output`'s 50-image sweep. They finished the full inspect→convert→C-reader→gcc→run chain with a self-consistent schema before the timer.

- **Opus attempt-4 — the single strong-model failure — got the C side working but broke the contract.** `tests.log` shows the binary exists and *executes* (returncode 1, not 127): `stderr='Error: Missing dimensions in JSON'`. So opus-a4 wrote a `cli_tool.c` that expected the layer **dimensions to be carried inside `weights.json`**, but its `convert.py` (or hand-written JSON) omitted them — the two artifacts it produced disagreed on the schema. It built a runnable tool against a JSON contract its own converter didn't fulfill. This is the exact failure the reference solution sidesteps by **hard-coding the dims in C** (`#define INPUT_DIM 784 … HIDDEN_DIM 16`) so the JSON only needs to carry raw weights — no dimension keys to forget. The differentiator between winning opus attempts and a4 is not "did it write C" but "did the JSON writer and the JSON reader agree."

- **qwen (all 5): never reached the C half at all.** Its best attempts pass only `test_weights_file_exists` — i.e. it managed the pytorch→`weights.json` conversion (and on a3/a5 not even that) but `test_cli_tool_exists` fails with `File /app/cli_tool does not exist` and `test_cli_tool_executable` returns `127 … /app/cli_tool: not found`. There is no binary. qwen burned its whole 713 s budget on the Python/inspection side and timed out before ever writing/compiling `cli_tool.c`. Its failure is *throughput/planning* — it didn't allocate time to the harder C-compilation half — not a schema bug.

**Bottom line:** the winning approach is defined by two things the failures each miss: (1) **finishing the C-compilation half within budget** (qwen's gap), and (2) **keeping the self-invented `weights.json` schema identical between the Python writer and the C reader** — which the reference nails by pushing all dimension knowledge into C `#define`s so the JSON is pure weight data (opus-a4's gap). Ours (gpt-5.4 and gpt-5.5) lands both and solves it, at notably low output-token cost (~3.8–4.8k out).

## Files
- `reference-solve.sh` — gold solution, verbatim.
- `scaffolds/*.SOLVED.commands.txt` — the two solved winners (sonnet a1, opus a1), harness wrapper + reconstructed passing test evidence.
- `scaffolds/*.commands.txt` — two representative failures: opus a4 (schema-mismatch, got furthest) and qwen a1 (no binary built).

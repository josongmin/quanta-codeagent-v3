# Terminal-Bench task: `gpt2-codegolf` — a genuine 0/17 ceiling

**Goal (1 line):** write a dependency-free C file (`/app/gpt2.c`, compiled `gcc -O3 -lm`, **must be < 5000 bytes**) that loads GPT-2 124M weights from a TF `.ckpt` + a `.bpe` vocab and arg-max-samples the next 20 tokens for a given prompt.

This folder documents **HOW the frontier fails**, because *nobody* solves this task — 0 resolved across every public scaffold/model run we have, plus both of our own models.

---

## Solve table

Public leaderboard runs available locally: 3 orchestrator×model configs × 5 runs = **15 runs** (the "~17" estimate). Each config is the `abacus` **orchestrator** scaffold with a different backing model. All 15 → `is_resolved=false`. `failure_mode` below is the harness-level tag from `results.json`; the **real test-level signature** is recovered from `panes/post-test.txt` (the on-box `results.json` token counts are all `null` for this dataset, so median-out-tokens is **not recorded** — see note).

| scaffold (orchestrator) | model | resolved best-of-5 | dominant `failure_mode` (results.json) | real test-level failure (post-test panes) | median out-tokens |
|---|---|---|---|---|---|
| abacus orchestrator | claude-4.1-opus | **0 / 5** | `agent_timeout` (5/5) | 1× segfault (SIGSEGV -11), 1× buffer-overflow abort, 1× compile error, 2× file-never-written | not recorded (null) |
| abacus orchestrator | claude-4-sonnet | **0 / 5** | `parse_error` (3/5), `agent_timeout` (2/5) | 1× echoed input verbatim ("Wrong output"), 1× exec fail, 3× no scorable result | not recorded (null) |
| abacus orchestrator | qwen-3-coder-480B | **0 / 5** | `agent_timeout` (5/5) | 1× placeholder/stub ("Generated tokens: 5 6 7 8…", "Wrong output"), 4× file-never-written | not recorded (null) |
| **quanta (ours)** | **gpt-5.4** | **0** (reward 0) | — | our brain does not capture a command trace | in/out not recorded |
| **quanta (ours)** | **gpt-5.5** | **0** (reward 0) | — | our brain does not capture a command trace | **out ≈ 6850** (in ≈ 99289) |

**Confirmed: 0 / 17** — 15 public runs (0/15) + our 2 models (0/2). Not a single resolve anywhere, from cheap `qwen-3-coder-480B` up through frontier `claude-4.1-opus` / `claude-4-sonnet` / our `gpt-5.5`.

> Token note: for this abacus dataset every `results.json` has `total_input_tokens: null` / `total_output_tokens: null`, so the per-run "median out-tokens" cannot be computed from real data and is marked *not recorded* rather than guessed. The only real token datapoint is our own gpt-5.5 run (`out ≈ 6850`) from `/tmp/our-tb-results.json`.

---

## Reference approach (what `solve.sh` actually does — the bar)

`reference-solve.sh` (copied verbatim) writes a **single hand-golfed C file** and nothing else. The canonical solution is a **complete GPT-2 forward pass** — BPE tokenizer, weight loading straight from the TF checkpoint layout, LayerNorm, multi-head causal attention, MLP with a GELU (`tanh` approximation), the full 12-layer transformer stack, and arg-max detokenization — expressed in an extreme code-golf style:

- Embedded C is **3271 bytes** (whole `solve.sh` is 3437 bytes), **218 lines** — i.e. it clears the 5000-byte gate with **~1729 bytes of headroom**, but only because *every* construct is compressed: 1-char globals (`V,C,L,c,d,U`), macro factories that stamp out elementwise/broadcast ops (`#define J(S,B)…`, `#define E(S,B)…`, `#define O(i,j)for…`), a typedef'd `{float*i;int j,k;}` tensor struct `A` passed **by value**, a bump-allocator (`D+=U=4*j*k`) instead of per-tensor `malloc`, and model hyperparameters **decoded from the checkpoint filename bytes** (`U=F[1][5]+3*F[1][7]+3&3`).
- It re-implements matmul, transpose, softmax (`z=exp`, normalize by `X`=row-sum), the causal mask (`Q` macro: `(i/k<i%k)?0:exp(b/8)`), and greedy token selection by hand — no BLAS, no libm beyond `exp/tanh/sqrt`.

**Why matching this is hard:** the task is not "write GPT-2 in C" (models can do that at a few hundred lines) — it's "write a *correct* GPT-2 forward pass **and** golf it under 5000 bytes **and** get the exact TF-checkpoint weight tensor layout right **and** the BPE merge logic right, all in one shot before the agent times out." Any one of those alone is doable; the conjunction is what nobody clears.

---

## Key insight: a genuine ceiling, and where agents actually break

This is **0/17 across all scaffolds AND all model tiers** — from cheap `qwen-3-coder-480B` to frontier `claude-4.1-opus`/`claude-4-sonnet` and our `gpt-5.5`. That rules out "wrong model" — it's a **capability/task-shape ceiling**, not a scaffold-tuning gap.

**Dominant `failure_mode` = `agent_timeout`** (10/15 tagged agent_timeout, remaining 5 are sonnet `parse_error`). But the harness tag hides the real story. Reading `panes/post-test.txt`, the failures fall into a clean taxonomy, and they are **not** primarily "hit the 5000-byte wall":

1. **Never finished / file-never-written (7 runs)** — `AssertionError: File /app/gpt2.c does not exist`. The agent burned its entire time budget still working and never wrote the artifact. This is the single largest bucket (all timeouts). Getting a full transformer *correct in C* is so slow that the agent runs out the clock before producing anything scorable.
2. **Faked it — didn't actually implement the model (2 runs, "Wrong output")** — the most diagnostic bucket:
   - `qwen-3-coder-480B` shipped a **placeholder stub** that prints `Loading model weights … (placeholder)` / `Running inference (placeholder)` / `Generated tokens: 5 6 7 8 …` — no real forward pass at all.
   - `claude-4-sonnet` shipped a binary that **echoes the input back unchanged** (`stdout = 'THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT\n'`) — again no real inference.
   Both compiled and ran under 5000 bytes; they just don't compute GPT-2. When the real thing is too hard, models degrade to stubs that pass compile/size but fail correctness.
3. **Real attempt, but crashes at runtime (2 runs)** — `claude-4.1-opus` produced compiling, sub-5000-byte binaries that **segfault** (`returncode -11`) or trip `*** buffer overflow detected ***`. This is the closest anyone gets: real forward-pass code, wrong pointer/tensor arithmetic (the golf'd manual memory layout is exactly where it goes wrong).
4. **Compile error (1 run)** — `claude-4.1-opus` run 5 emitted C that doesn't even parse (`gpt2.c:129: expected declaration specifiers … before string constant`).

**Where agents get stuck (net):** the **< 5000-byte constraint is almost never the proximate failure** — nobody's failing artifact is rejected for being too big. The wall is **correctness under a hard time budget**: either (a) the full correct forward pass takes too long to write → timeout with no file, (b) the model punts to a placeholder/echo stub that's correct-size but computationally empty, or (c) it writes real golf'd C whose hand-managed pointer/tensor layout segfaults. The reference clears the bar with 1729 bytes to spare, so size is *achievable* — what nobody achieves is **a correct, non-crashing GPT-2 forward pass in one shot**.

---

## Files here

- `reference-solve.sh` — the canonical solution, verbatim (3271-byte embedded C).
- `scaffolds/*.commands.txt` — 4 representative FAILING runs across diverse scaffolds/models (opus-segfault, opus-compile-error, qwen-placeholder-stub, sonnet-echoed-input). **Caveat:** in this abacus dataset `commands.txt` contains only the test-harness recording wrapper (`asciinema rec` / `run-tests.sh`) — the orchestrator agent's own command trajectory was not captured on-box, so each file pairs the wrapper with the ANSI-stripped `panes/post-test.txt`, which is where the produced C + real failure signature actually live.

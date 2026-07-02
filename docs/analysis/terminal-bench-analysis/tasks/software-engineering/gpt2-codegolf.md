---
task: gpt2-codegolf
category: software-engineering
difficulty: hard
tags: []
expert_min: 2400
junior_min: 9600
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/gpt2-codegolf:20251031
---

# gpt2-codegolf

**Goal** — Write a dependency-free C file `/app/gpt2.c` (< 5000 bytes) that reads the GPT-2 124M TF `.ckpt` and a `.bpe` vocab, and, compiled with `gcc -O3 -lm`, does arg-max sampling to continue a given prompt for the next 20 tokens.

**Solution shape** — A single, extreme code-golfed C file (~4KB, deeply macro-compressed). It hand-implements the entire GPT-2 forward pass from scratch: a tiny tensor struct + macros for elementwise/matmul/softmax/layernorm/GELU, a BPE tokenizer (greedy `Y`/`w` merge search over the vocab), manual parsing of the raw `.ckpt` float blobs into weight tensors, 12-layer transformer with multi-head attention, and an arg-max token loop printing detokenized output. No libraries beyond libc/libm. The whole challenge is fitting a correct GPT-2 into <5000 bytes.

**Verifier** — pytest: `gpt2.c` exists and is < 5000 bytes; compiles with `gcc -O3 gpt2.c -lm`; runs on the ckpt/bpe with prompt `THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT` and stdout must contain `WARRANTY OF ANY KIND, EXPRESS OR IMPLIED` (i.e. GPT-2's deterministic arg-max continuation). reward binary 0/1. Correctness is exact: the model math must reproduce GPT-2's greedy output.

**Difficulty drivers** — One of the hardest tasks here (expert est. 40h). Requires implementing a full transformer inference stack — BPE tokenization, checkpoint parsing, attention/MLP/layernorm/GELU, arg-max decode — correctly enough to match reference tokens, AND squeezing it under a 5000-byte source limit via aggressive golfing. Any numeric or parsing error changes the arg-max path and fails; the byte budget forbids clean, verbose code.

**quanta attack points** — Pure authoring: `container_exec` to write `gpt2.c`, compile, and run; no interactivity. Main failure risk: subtle bugs in ckpt layout parsing, attention/softmax, or BPE that shift the greedy output, plus busting the 5000-byte cap when trying to make it correct. The exit-code loop is only weak leverage — the test gives a single pass/fail on one continuation string with no intermediate signal, so the agent must get the numerics right largely from first principles rather than iterating against feedback.

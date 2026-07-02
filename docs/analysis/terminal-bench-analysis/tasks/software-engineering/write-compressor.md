---
task: write-compressor
category: software-engineering
difficulty: hard
tags: [coding]
expert_min: 1440
junior_min: 4800
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/write-compressor:20251031
---

# write-compressor

**Goal** — Given a fixed decompressor `/app/decomp.c` (reads compressed bytes on stdin, writes decompressed text to stdout) and a text file `/app/data.txt`, produce `/app/data.comp` such that `cat data.comp | /app/decomp` reproduces `data.txt` **exactly**, and `data.comp` is **≤ 2500 bytes**. Any means of generating the compressed file is allowed; the decompressor format is fixed and must be matched.

**Solution shape** — Bash compiles a ~600-line `main.rs` (Rust) encoder written to exactly mirror `decomp.c`'s decode format, then `cat data.txt | ./main > data.comp`. The encoder is a full **arithmetic/range coder with a context-modeling LZ compressor**: a DP (`compress_dp`) chooses between literal and match tokens minimizing an entropy cost estimated by a `FakeRangeEncoder`; a real `RangeEncoder` then serializes tokens via binary-search range coding over a radix-255 byte stream with per-context adaptive bit models, and a mirrored `RangeDecoder` round-trips to self-verify (`assert_eq!(out, raw)`) before output. This is a from-scratch reimplementation of the decompressor's exact bit-level protocol.

**Verifier** — pytest: copies pristine `original-decomp.c`/`original-data.txt` in, `gcc`-compiles the decompressor, checks `data.comp` exists, runs `cat data.comp | decomp2` and asserts stdout **exactly equals** `data.txt`, and asserts `data.comp` size ≤ 2500 bytes. reward binary 0/1.

**Difficulty drivers** — By far the hardest here (expert 24h, junior 80h). The agent must **reverse-engineer the decompressor's exact entropy-coding format** from C source, then build a matching encoder (context model, range coder, token DP) that both round-trips bit-perfectly *and* hits an aggressive size budget. Deep information-theory + careful bit-exact protocol matching; a single off-by-one in context indexing breaks the round-trip.

**quanta attack points** — `container_exec` iterate: compile encoder, run round-trip, check size — the round-trip self-check and byte-diff are exit-code observable, so the "iterate until tests pass" loop is technically usable, but the real work is design-level reverse-engineering that iteration alone won't brute-force. Main risk is faithfully modeling the decoder's adaptive contexts and radix stream; the 2500-byte cap means a merely-correct compressor may still fail. No interactivity; the challenge is algorithmic depth, not terminal orchestration.

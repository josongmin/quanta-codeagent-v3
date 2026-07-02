---
task: feal-linear-cryptanalysis
category: mathematics
difficulty: hard
tags: [software-engineering]
expert_min: 960
junior_min: 19200
skill_class: ADVERSARIAL-SEC
terminal_native: med
docker_image: alexgshaw/feal-linear-cryptanalysis:20251031
---

# feal-linear-cryptanalysis

**Goal** — `/app/feal.c` is a FEAL-like 4-round cipher (each round key derived from a 20-bit seed), with `decrypt.c` and 32 known plaintext/ciphertext pairs in `pairs.txt`. Implement a known-plaintext linear attack to recover the round keys, then decrypt `ciphertexts.txt` into `/app/plaintexts.txt`.

**Solution shape** — A single ~300-line C program (`attack.c`) built with `gcc -O3`, reimplementing the cipher's f-function/round structure. It hardcodes 15 precomputed linear-approximation masks (5 per round × 3 rounds), and for each round brute-forces the 2^20 seed space, keeping the seed whose masked parity is perfectly biased (all-zero or all-one) across the known pairs. The 4th key is recovered by direct 2^20 brute force against a few pairs, then all four 20-bit seeds are re-derived and `./decrypt ciphertexts.txt 0x.. ..` is invoked via `system()` to emit plaintexts.

**Verifier** — pytest: reads `/app/plaintexts.txt` and asserts each of 100 expected decimal plaintext values appears in the file (substring check). Effectively requires full correct key recovery.

**Difficulty drivers** — Serious cryptanalysis: understanding FEAL, deriving linear approximations / bias masks, and structuring a per-round key-recovery attack — not brute-forceable over the full keyspace. Expert est. 16h, junior est. 320h (the hardest reasoning task in this batch). Getting the mask math wrong yields no recovered key at all.

**quanta attack points** — `container_exec` for edit→gcc→run cycles; no TUI. Main risk: the linear-approximation derivation is a pure-math bottleneck the test can't guide toward — the pass/fail signal only fires once *all* keys are correct, so there's little incremental feedback. The iterate-until-pass loop barely helps; success depends on the agent actually deriving/knowing the FEAL linear attack up front.

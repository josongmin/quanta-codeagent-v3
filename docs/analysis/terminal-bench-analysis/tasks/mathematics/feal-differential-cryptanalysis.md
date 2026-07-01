---
task: feal-differential-cryptanalysis
category: mathematics
difficulty: hard
tags: [software-engineering]
expert_min: 480
junior_min: 19200
skill_class: ADVERSARIAL-SEC
terminal_native: low
docker_image: alexgshaw/feal-differential-cryptanalysis:20251031
---

# feal-differential-cryptanalysis

**Goal** — Given `/app/feal.py` (a FEAL-like cipher whose 6 round keys derive from a 16-bit seed), implement a chosen-plaintext differential attack in `/app/attack.py` exposing `attack(encrypt_fn)` that recovers the uint32 `key[5]` in under 30 seconds.

**Solution shape** — Single ~90-line Python file written via heredoc. Reimplements the FEAL G/F functions, then runs a classic differential attack: fix input difference `b=0x8080000080800000`, and over 10 rounds of chosen-plaintext queries filter a candidate list (keyed by `maybe_key = (i*1234567)&0xFFFFFFFF`) by checking that peeling the last round's F-function reproduces the expected output XOR difference `0x02000000`. Survivors converge to the single correct `key[5]`. No external deps.

**Verifier** — pytest: builds a C reference cipher (`feal_in_c` via `setup.py build_ext`) from `feal.c`/`feal_module.c`, calls `create_random_keys()`, then asserts `attack(feal_in_c.encrypt) == get_keys()[5]`. Exact uint32 equality against a freshly randomized key, so the attack must be genuinely correct (not fitted to one key), and must finish within the harness timeout. reward binary 0/1.

**Difficulty drivers** — Heavy cryptanalysis domain knowledge: understanding FEAL's round structure, choosing the right input differential, and doing last-round key peeling via differential characteristics. The 30-second budget rules out brute force over even the reduced keyspace. Correctness is exact-match against randomized keys, so a heuristic that works occasionally fails.

**quanta attack points** — Essentially a coding/algorithm task — `container_exec` to write `attack.py` and run pytest; no interactivity, terminal is just the runtime. Main failure risk: the differential math being subtly wrong (recovers the wrong round key or only works for some seeds) or exceeding the time budget. The exit-code loop is only weak leverage — the test emits a single pass/fail on one recovered integer, giving no signal about *why* the differential is off; success rides on getting the cryptanalysis right up front.

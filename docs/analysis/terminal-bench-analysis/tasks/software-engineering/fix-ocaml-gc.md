---
task: fix-ocaml-gc
category: software-engineering
difficulty: hard
tags: [troubleshooting]
expert_min: 1440
junior_min: 14400
skill_class: DEBUG-FIX
terminal_native: med
docker_image: alexgshaw/fix-ocaml-gc:20251031
---

# fix-ocaml-gc

**Goal** — A modified OCaml garbage collector (run-length-compressing free space in the major heap) has a bug that crashes the compiler while bootstrapping. Read `HACKING.adoc`, find and fix the bug in the runtime, and make the basic testsuite pass: `make -C testsuite one DIR=tests/basic`.

**Solution shape** — Deep debugging distilled to a **one-line fix**: `solve.sh` is a single `sed` changing `Whsize_hd(hd)` → `wh` on line 650 of `/app/ocaml/runtime/shared_heap.c` (the compressed-free-space sweep used the wrong word-size expression, so free-block bookkeeping was corrupted). The real work is entirely diagnostic — building the compiler, reproducing the bootstrap crash, and localizing the faulty size computation in the GC sweep path. Effectively 1 changed line, but hours of investigation.

**Verifier** — pytest reads `/app/ocaml/tests.txt` (produced by the testsuite run, overwritten by the harness so it can't be faked) and asserts "40 tests passed" appears. Binary 0/1.

**Difficulty drivers** — The hardest task in the batch by estimate (expert 1440 min). Requires C + OCaml-runtime internals expertise: GC major-heap sweeping, header word-size macros, and the bootstrap build. Long build/reproduce cycles, subtle memory-corruption symptom far from the root cause. Env is pre-set (source tree present); the difficulty is pure fault localization.

**quanta attack points** — `container_exec` for build + testsuite runs (each a slow exit-code signal). No TUI, but the loop is *expensive*: every reproduce requires rebuilding the compiler, so blind iterate-until-green is impractical. Main risk is localization — the agent must reason about GC size macros from crash symptoms, not brute-force. The exit-code loop confirms the fix but gives little guidance toward it.

---
task: path-tracing-reverse
category: software-engineering
difficulty: hard
tags: [images]
expert_min: 120
junior_min: 1440
skill_class: ADVERSARIAL-SEC
terminal_native: low
docker_image: alexgshaw/path-tracing-reverse:20251031
---

# path-tracing-reverse

**Goal** — Given only a compiled binary `/app/mystery` (a path tracer that writes `image.ppm`), write `/app/mystery.c` that reproduces its behavior identically. `gcc -static -o reversed mystery.c -lm && ./reversed` must match. Constraints: source must be <2 KB gzipped, must not invoke `./mystery`, and must run fully standalone.

**Solution shape** — `solve.sh` heredoc-writes a `mystery.c` that is a **minified re-implementation** of a ~320-line C ray/path tracer (the un-minified original is in `environment/orig.c`: Vector3 math, sphere intersection, ray casting, lighting, PPM output). The provided solution aggressively shortens identifiers (`Vector3`→`Z`, functions →single letters) and strips whitespace to fit under the 2 KB gzip budget while preserving the exact floating-point algorithm. One file; the whole task is recovering + compressing the algorithm.

**Verifier** — pytest: `mystery.c` exists; compiles with `gcc -static … -lm` and gzip-compressed size < 2100 bytes; then runs the **original binary** and the agent's compiled `reverse` each inside a fresh `chroot` jail, and requires **cosine similarity ≥ 0.995** between the two output PPM images. Binary 0/1.

**Difficulty drivers** — Hard reverse-engineering: reconstruct a numerically-exact rendering algorithm from a binary (decompilation or careful I/O inference) such that images match to >99.5% — floating-point/lighting/scene-geometry must be right, not approximate. Then a code-golf constraint (<2 KB gzip) layered on top, plus a self-containment rule (can't shell out to the binary). Very long junior estimate (1440 min).

**quanta attack points** — `container_exec`: disassemble/objdump, write C, compile, run, compare PPMs. No interactivity, low terminal-native (fundamentally a code-authoring/RE task where the terminal is just the runtime). The exit-code loop *can* help — the agent can compile and compare its output to the original binary's PPM (running `./mystery` for reference only, not from within the C) — but the chroot-isolated grader and the exact-match + size constraints make convergence genuinely hard. RE skill dominates over harness iteration.

---
task: extract-elf
category: file-operations
difficulty: medium
tags: []
expert_min: 30
junior_min: 240
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/extract-elf:20251031
---

# extract-elf

**Goal** — Write `/app/extract.js` so that `node extract.js /app/a.out > out.json` parses the compiled ELF binary and emits a JSON map of memory-address → integer value. Must match ≥75% of the reference solution's addresses, with zero incorrect values for any address included.

**Solution shape** — No `solve.sh` reference beyond the canary header is provided as a standalone author solution; the *reference implementation* lives embedded in `tests/test_outputs.py` (the `REF` string). It's a ~300-line pure-Node ELF parser: reads the ELF header (32/64-bit, endianness), walks section headers via `shstrtab`, loads `.text`/`.data`/`.rodata` into a memory dict as little-endian 4-byte words keyed by `vaddr+offset`, parses symbol tables for function bounds, and prints `JSON.stringify(memory)`. Single JS file, no deps (uses `fs`).

**Verifier** — pytest compiles a fresh `new.c` with gcc, runs the agent's `extract.js` and the embedded reference on the same `.o`, then requires: (1) every address the agent outputs whose key also appears in the reference has an *identical* value (no mismatches allowed), and (2) ≥75% of reference keys are present. Binary 0/1.

**Difficulty drivers** — Binary-format literacy: must understand ELF section headers, virtual addresses, endianness, and 4-byte word packing well enough to reproduce the exact address→value mapping the reference uses. The "any wrong value fails" rule punishes off-by-N offset or endianness mistakes; 75% coverage forces loading the right sections. It's a self-contained coding task once the ELF spec is understood.

**quanta attack points** — Pure `container_exec`: write file, `node extract.js`, diff against a self-compiled binary. No interactivity. This is essentially a low-terminal-native SWE task — the exit-code "iterate until tests pass" loop is very effective here because the agent can compile its own `.o`, run node, and compare JSON to converge on correct offsets/endianness deterministically.

---
task: make-mips-interpreter
category: software-engineering
difficulty: hard
tags: [software-engineering]
expert_min: 480
junior_min: 3600
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/make-mips-interpreter:20251031
---

# make-mips-interpreter

**Goal** — Given a MIPS ELF (`/app/doomgeneric_mips`) and its `doomgeneric/` source, implement a full MIPS interpreter `vm.js` such that `node vm.js` loads and executes the ELF (a port of DOOM), handling syscalls and file I/O, and renders/saves the first frame. Must boot DOOM and produce a correct first frame.

**Solution shape** — `solve.sh` heredocs a large single `vm.js` (~1990-line script, ~65KB): a `MIPSVM` class with 32 registers, HI/LO, PC, a memory map, ELF loader, a full MIPS instruction decoder/executor (R/I/J formats), and a syscall layer wired to Node `fs` for reads/writes and framebuffer output (writes `/tmp/frame.bmp`). Pure authored emulator — no build, no deps beyond Node's stdlib.

**Verifier** — pytest: spawns `node /app/vm.js`, waits ≤30s for `/tmp/frame.bmp` to appear, asserts stdout contains `I_InitGraphics: DOOM screen size: w x h: 320 x 200`, that `frame.bmp` is non-empty, and that it is ≥95% pixel-similar (avg per-channel L1) to `/tests/reference.jpg`. reward 0/1.

**Difficulty drivers** — Very hard, long-horizon systems programming: correct implementation of the entire MIPS ISA (arithmetic/logical/branch/jump/load-store, delay slots, sign-extension), an ELF loader, and a syscall ABI faithful enough to boot a real DOOM binary and produce a pixel-accurate frame. Any instruction or memory bug corrupts the frame. 8h expert / 60h junior estimate reflects the scale. Emulation runtime performance matters (30s frame deadline).

**quanta attack points** — Fundamentally a large code-authoring task; `container_exec` to write `vm.js` and run `node vm.js`, checking the init string / frame output. No interactivity, so `pty_*` unneeded. The exit-code loop only weakly helps: the observable signals (init string, frame similarity) are coarse and late — a single wrong opcode can silently corrupt output with no localized error, so blind iterate-until-pass is inefficient. Success needs correct-by-construction ISA implementation plus incremental instruction-level tracing/diffing against the real binary's behavior. Main risk: subtle opcode/delay-slot/memory bugs that only manifest as a wrong frame.

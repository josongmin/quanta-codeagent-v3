---
task: make-doom-for-mips
category: software-engineering
difficulty: hard
tags: [software-engineering]
expert_min: 480
junior_min: 1920
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/make-doom-for-mips:20251031
---

# make-doom-for-mips

**Goal** — Given doomgeneric source, a provided `doomgeneric_img.c` (writes each frame to `/tmp/frame.bmp`), and a `vm.js` MIPS emulator expecting a file `doomgeneric_mips`, cross-compile doom into a MIPS ELF `doomgeneric_mips` so `node vm.js` runs it, prints DOOM init text, and renders frames.

**Solution shape** — `solve.sh` applies a large embedded git patch that rewrites the doomgeneric Makefile into a bare-metal MIPS cross-compile pipeline: clang `-target mips-unknown-linux-gnu` `-emit-llvm` per source → `llc -march=mipsel -mcpu=mips32r2` to asm → `mips-linux-gnu-as` → `mips-linux-gnu-ld`, with a custom `my_stdlib` (nostdinc, own libc), `doomgeneric_img.o`, static relocation, `-EL`. Builds the freestanding ELF the JS VM loads. Very large solve (thousands of lines, most of it the patch/embedded vm.js data).

**Verifier** — pytest (PIL). Runs `node /app/vm.js`, waits up to 30s for `/tmp/frame.bmp`; asserts stdout contains `I_InitGraphics: DOOM screen size: w x h: 320 x 200`; asserts `frame.bmp` exists and non-empty; compares `frame.bmp` to `/tests/reference.jpg` (same size, per-pixel avg abs diff → >=95% similarity). reward 0/1.

**Difficulty drivers** — Bare-metal cross-compilation to MIPS with a hand-rolled libc and a full LLVM-IR→asm→as→ld toolchain, a freestanding freestanding runtime that must run under a JS emulator, and a rendered-frame similarity check (the port must actually run DOOM to first frame). Toolchain/ABI/relocation expertise, 8h expert estimate. Deeply systems-level.

**quanta attack points** — `container_exec` for the whole build: install MIPS toolchain + llc, patch the Makefile, `make`, then `node vm.js` and inspect stdout + `/tmp/frame.bmp`. Main failure risk is the freestanding toolchain (missing symbols, wrong endianness/relocation model, libc gaps) producing an ELF the VM can't run, or a frame that renders wrong. The exit-code/log loop helps for build errors, but the final gate is a runtime image-similarity check the agent can only satisfy by getting the emulator to boot to a correct first frame. Strongly terminal-native.

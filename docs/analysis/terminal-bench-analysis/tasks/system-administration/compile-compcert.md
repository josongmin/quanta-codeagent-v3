---
task: compile-compcert
category: system-administration
difficulty: medium
tags: [compilation, compilers]
expert_min: 60
junior_min: 120
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/compile-compcert:20251031
---

# compile-compcert

**Goal** — Build the CompCert verified C compiler (v3.13.1) from source under `/tmp/CompCert/`, configured for the host OS/arch, invokable as `/tmp/CompCert/ccomp`. Must be freshly built from source and fully functional (not a fake wrapper).

**Solution shape** — `solve.sh` apt-installs opam + build deps (m4, libgmp-dev, libzstd-dev, etc.), `opam init`, creates an OCaml 4.14.2 switch, adds the coq-released repo, and `opam install coq.8.16.1 menhir.20230608` (the verified-compiler build chain). Clones CompCert `v3.13.1`, detects arch (x86_64→`x86_64-linux`, aarch64→`aarch64-linux`), `./configure` + `make -j1` + `make install`, and symlinks the installed ccomp to `/tmp/CompCert/ccomp`. Long dependency-heavy build script.

**Verifier** — pytest. `ccomp` exists, is a regular executable, `ccomp -version` contains "3.13". Compiles `positive_probe.c` → ELF, checks `.comment` section has NO clang/llvm/gnu signatures (anti-fake), runs it with random input asserting exact string-reversal output + specific exit codes (2 on no-arg, 0 on empty). Compiles `negative_probe.c` (a VLA) and asserts CompCert REJECTS it (VLAs unsupported → authenticity proof). reward 0/1.

**Difficulty drivers** — A long, dependency-heavy toolchain build: opam/OCaml/Coq/menhir version pinning, arch-aware `./configure`, and a slow `make` (2400s verifier timeout). The anti-cheat checks (`.comment` must not show gcc/clang, must reject VLAs, exact version) mean you can't fake it with a shim over another compiler — you must actually build genuine CompCert. Classic build-from-source sysadmin with authenticity traps.

**quanta attack points** — `container_exec` for the entire build/install and to run `ccomp` on probe files. Main failure risk is the fragile opam/Coq dependency resolution and long build (transient failures, version mismatches) plus the temptation to shim another compiler (blocked by the .comment/VLA authenticity checks). The exit-code/log loop is exactly right for iterating on build errors. Strongly terminal-native; no interactive component.

---
task: build-pov-ray
category: software-engineering
difficulty: medium
tags: [build-tools, compilation, graphics, ray-tracing, legacy-software, research]
expert_min: 60
junior_min: 180
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/build-pov-ray:20251031
---

# build-pov-ray

**Goal** — Find, download, extract (to `/app/povray-2.2`), compile, and install **POV-Ray 2.2** (a 1990s C ray tracer) to `/usr/local/bin/povray`. It will be graded by rendering `/app/deps/illum1.pov` and comparing to a reference image. Don't modify the scene file.

**Solution shape** — `solve.sh` installs build-essential/wget/ncompress; `wget`s the three official `.TAR.Z` archives (POVDOC/POVSCN/POVSRC) from povray.org's old-versions FTP; `uncompress` + `tar -xf`; copies `machine/unix/*` into `source/`, renames `unixconf.h`→`config.h`. Then a series of `sed` patches to make 1994 K&R C build on modern gcc: add a deterministic `pov_rand`, switch `-O`→`-O2 -std=c89 -Wno-error -DMAX_CONSTANTS=2000`, fix `MAIN_RETURN_TYPE`, prepend `#include <stdlib.h>` to every `.c`, comment out an old `malloc` proto. `make -f unix.mak`, install binary, reorganize files under `/app/povray-2.2`. Substantial legacy-porting script.

**Verifier** — pytest renders `illum1.pov` to TGA at 640×480, converts to PNG, checks size/format, and requires **SSIM > 0.87** vs `reference_illum1.png`. Also asserts `povray -h` output contains "2.2" (right version) and MD5-verifies several extracted source/doc files + the unmodified scene file (anti-cheat / correct-version proof). Binary 0/1.

**Difficulty drivers** — Classic legacy-build hell: locating the exact 2.2 archives, then making decades-old C compile under a modern toolchain (missing includes, K&R prototypes, RNG, warning-as-error, constant limits). MD5 checks force the *authentic* 2.2 source; the SSIM render check means the build must be numerically correct, not just compile. Deterministic RNG matters for pixel match. Long, fiddly, high domain-specific friction.

**quanta attack points** — Heavily `container_exec`: download, extract, sed-patch, make, render. No interactivity. High terminal-native — this is quintessential terminal-agent work (dependency archaeology + iterative compile-fix). The exit-code "iterate until it builds/renders" loop is a strong fit: each `make` failure surfaces a concrete error to patch, and the agent can render locally and eyeball statistics before the SSIM grader.

---
task: build-pmars
category: software-engineering
difficulty: medium
tags: [build-tools, compilation, debian, gaming, pmars, corewars]
expert_min: 90
junior_min: 270
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/build-pmars:20251031
---

# build-pmars

**Goal** — Build the pMARS Core War simulator from **Debian source** with no X11/X server support, extract the source to `/app`, and install the binary to `/usr/local/bin/pmars`. The `-e` debugger and `-b -r 50` battle mode must work.

**Solution shape** — Sysadmin, no app code authored. `solve.sh` enables `deb-src`, apt-installs pinned `build-essential`, `libncurses-dev`, `dpkg-dev`, `devscripts`; runs `apt-get source pmars` to fetch/extract the Debian source tree into `/app` (deliberately avoids `apt build-dep`, which would pull X11). Then it patches the Makefile (`sed` to strip `-DXWINGRAPHX` and set `LIB = -lncurses`), `make clean && make`, and `install`s the binary. A few commands + two sed edits.

**Verifier** — pytest: binary exists at `/usr/local/bin/pmars`; the `-e` debugger steps through both bundled warriors (regex on ≥2 stepped addresses); `-b -r 50 -f flashpaper.red rave.red | tail -1` matches `Results: X Y Z`; `ldd` shows no libX11/libXt/libXext/libXaw; a `pmars-*` dir with `debian/` and `src/*.c` exists in `/app`. Binary 0/1.

**Difficulty drivers** — Build-system surgery: knowing `apt-get source` vs `build-dep`, editing the legacy Makefile to disable the X graphics build and link ncurses instead, and satisfying multiple structural checks (Debian provenance, no-X11 linkage, working curses debugger). Moderate; the friction is Makefile/link config, not algorithms.

**quanta attack points** — `container_exec` for apt/source/make/install/ldd — each with a clear exit code, and `ldd`/battle-output are easy to self-check, so the exit-code loop is strong. No interactive TUI (debugger driven via piped `s\ns\nq`). Main risk: leaving an X11 dependency linked, or fetching source the wrong way so the `debian/` provenance check fails. High terminal-native — it's compilation/system-state work end to end.

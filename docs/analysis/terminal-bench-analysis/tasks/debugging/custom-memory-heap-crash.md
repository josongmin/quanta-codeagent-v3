---
task: custom-memory-heap-crash
category: debugging
difficulty: medium
tags: [cpp, memory-management, debugging]
expert_min: 30
junior_min: 1200
skill_class: DEBUG-FIX
terminal_native: med
docker_image: alexgshaw/custom-memory-heap-crash:20251031
---

# custom-memory-heap-crash

**Goal** — A C++ program at `/app/` crashes in RELEASE (`-O2 -DNDEBUG`, custom libstdc++) but not DEBUG. Fix it by editing ONLY `/app/user.cpp` (other files are checksum-protected). Must have no Valgrind-detected memory leaks.

**Solution shape** — Diagnostic-then-tiny-fix bash. Compiles debug + release with the exact instructed g++ invocations (static-linked custom libstdc++ variants), enables core dumps, runs release to capture the crash, then `gdb -batch bt` on the coredump to trace it to `~_Fac_node` (locale facet) destruction during static cleanup after the custom heap is gone. The actual fix rewrites `user.cpp` to just call `std::stringstream` in `user_init()` so locale facets are lazily allocated via malloc BEFORE the custom heap exists — a ~15-line file. Recompiles and verifies exit 0.

**Verifier** — pytest: MD5 of protected files (`main.cpp`, `user.h`) unchanged; debug + release both compile; debug runs clean; release runs clean (the bug fix); Valgrind `--leak-check=full --error-exitcode=1 --errors-for-leak-kinds=definite` passes (blocks `quick_exit`/`_Exit` cheats that skip destructors).

**Difficulty drivers** — Deep C++/STL runtime knowledge: static-destruction order, custom allocator vs libstdc++ facet lifetime, optimization-only manifestation. Requires coredump/gdb forensics and reading in-house libstdc++ source under `/build/`. Constrained edit surface + anti-cheat Valgrind gate. Junior est. 20h.

**quanta attack points** — `container_exec` for compile/run/gdb-batch/valgrind cycles — all exit-code driven, no TUI (gdb is used in `-batch` mode, so `pty_*` not required). Main risk: misreading the backtrace and "fixing" symptoms (or cheating with early-exit, which Valgrind catches). The iterate-until-tests-pass loop is strong here: compile→run→valgrind gives crisp binary signals to converge the fix, though understanding *why* still needs the gdb read.

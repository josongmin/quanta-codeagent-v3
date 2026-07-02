---
task: sqlite-with-gcov
category: system-administration
difficulty: medium
tags: [software-installation, system]
expert_min: 30
junior_min: 120
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/sqlite-with-gcov:20251031
---

# sqlite-with-gcov

**Goal** — Compile SQLite from the pre-vendored source snapshot (`/app/vendor/sqlite-fossil-release.tar.gz`, no network fetch) into `/app/sqlite` WITH gcov coverage instrumentation, and make the resulting `sqlite3` available on `PATH`.

**Solution shape** — `solve.sh` (~27 lines): `apt-get install fossil gcc tcl/jimsh make tzdata`; sets `USER`; extracts the tarball into `/app/sqlite` (`--strip-components=1`); runs `./configure --enable-fts3 --enable-session` with `CFLAGS="-g -ftest-coverage -fprofile-arcs"` (the gcov instrumentation flags); `make -j`; symlinks the built `sqlite3` into `/usr/local/bin` and appends `/app/sqlite` to `PATH` via `.bashrc`. Pure build/config, no authored code.

**Verifier** — pytest: runs `sqlite3 :memory: "SELECT sqlite_version();"` (must succeed, non-empty), confirms `sqlite3` is resolvable via `shutil.which` on PATH, then runs a query and asserts that `.gcda` files (created at runtime by instrumented binaries) AND `.gcno` files (created at compile) exist under `/app/sqlite`. reward 0/1.

**Difficulty drivers** — Knowing the exact gcov instrumentation flags (`-ftest-coverage -fprofile-arcs`) and threading them through SQLite's `./configure`/`make` so both `.gcno` (compile-time) and `.gcda` (run-time) coverage artifacts are actually emitted. Getting the offline fossil-tarball build to configure/compile and the binary onto PATH. Env/dep + build state, moderate.

**quanta attack points** — Entirely `container_exec` one-shot steps (extract, configure, make, symlink) driven by exit codes; build failures surface via non-zero exit + stderr, so the iterate-until-it-builds loop fits well. No interactivity. The agent can self-check by running `sqlite3` and `find . -name '*.gcda'`, closely mirroring the grader. Main risk: forgetting the gcov CFLAGS (binary builds but no coverage artifacts), or the binary not landing on PATH for the pytest subprocess.

---
task: polyglot-c-py
category: software-engineering
difficulty: medium
tags: [coding]
expert_min: 20
junior_min: 480
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/polyglot-c-py:20251031
---

# polyglot-c-py

**Goal** — Write a single file `/app/polyglot/main.py.c` that is a valid C/Python polyglot: `python3 main.py.c N` and `gcc main.py.c -o cmain && ./cmain N` must both print the k-th Fibonacci number (f(0)=0, f(1)=1).

**Solution shape** — One heredoc-written source file. The trick: an opening `#include <stdio.h>` and `#define sdf b /*` — the `/*` starts a C comment that hides the Python body from the C compiler, while Python sees the `#define` lines as comments and runs its own `fib_py` (reading `sys.argv[1]`, iterating). A triple-quoted `"""` string plus a closing `*/` then reopens C code: real `#include`s, a `fib_c` loop, and `main` parsing argv. Each language's comment/string syntax is used to mask the other language's code in the same file.

**Verifier** — pytest: asserts `/app/polyglot` contains *only* `main.py.c` (no stray build artifacts committed); compiles it with gcc; then for n in {42,10,0} runs both `python3 main.py.c N` and the compiled `cmain N`, requiring both outputs equal the expected Fibonacci value. reward binary 0/1.

**Difficulty drivers** — Medium: the algorithm is trivial, but constructing a file that both a C compiler and CPython parse without error is a syntax puzzle — you must interleave C preprocessor/comment/string constructs with Python comment/string constructs so each interpreter ignores the other's code. Junior est. is high (8h) precisely because the polyglot trick is non-obvious. Output must match exactly for both toolchains.

**quanta attack points** — Pure authoring: `container_exec` to write the file and run both gcc and python3; no interactivity. Main failure risk: one toolchain choking on the other's syntax (a stray token the C preprocessor sees, or a Python parse error), or leaving the compiled `cmain` in the polyglot dir (the "only main.py.c" assertion). The exit-code loop is a good fit — compiling and running under both interpreters gives immediate, concrete errors to converge the polyglot structure.

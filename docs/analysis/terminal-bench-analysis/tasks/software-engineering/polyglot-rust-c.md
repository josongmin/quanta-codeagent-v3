---
task: polyglot-rust-c
category: software-engineering
difficulty: hard
tags: [coding, no-verified-solution]
expert_min: 180
junior_min: 720
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/polyglot-rust-c:20251031
---

# polyglot-rust-c

**Goal** — Write a single file `/app/polyglot/main.rs` that is a valid polyglot: it must compile+run as both Rust (`rustc main.rs && main N`) and C++ (`g++ -x c++ main.rs -o cmain && cmain N`), and each must print the k-th Fibonacci number (f(0)=1, f(1)=1, f(2)=2, …). Targets rustc 1.75.0 / g++ 13.2.0.

**Solution shape** — Bash writes one hand-crafted `main.rs` (~140 lines). It exploits differences in comment/token parsing so the same bytes are seen as two different programs: nested `/* */` and `//` tricks hide/reveal regions per compiler; a barrage of C `#define` macros (`fn`, `let`, `u32`, `as`, `println`, `main`→`_main`, etc.) rewrite the Rust-looking body into valid C++, while `use std::env;` and a real `fn main()` Rust block compute Fibonacci; a C `mine::atoi` + C `main` provide the C++ path. Both paths implement the same iterative Fib loop. Pure syntactic dark-arts authoring — tagged `no-verified-solution`.

**Verifier** — pytest: `/app/polyglot` contains only `main.rs`; compiles with both `rustc` and `g++ -x c++`; runs f(0),f(1),f(2),f(10),f(42) and asserts both binaries print the expected values.

**Difficulty drivers** — Requires deep, simultaneous knowledge of Rust and C++ lexing/preprocessing to construct a file that both toolchains accept with the same runtime meaning — comment nesting, macro rewriting, and layout tricks that don't collide. Notoriously fiddly; "no verified solution" flag signals it's hard to get robustly right. Terminal is just the compiler runtime.

**quanta attack points** — `container_exec` for the write→rustc→g++→run cycle; no interactivity. Main risk: a construct that satisfies one compiler breaks the other (or the Fib indexing is off) — the two-compiler constraint makes edits brittle. The iterate-until-pass loop helps a lot: both compilers + 5 value checks give concrete errors, but convergence needs genuine polyglot insight, not just retries.

---
task: schemelike-metacircular-eval
category: software-engineering
difficulty: medium
tags: [software-engineering]
expert_min: 300
junior_min: 2440
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/schemelike-metacircular-eval:20251031
---

# schemelike-metacircular-eval

**Goal** — Write `eval.scm`, a metacircular evaluator for the scheme-like language implemented by the provided `interp.py`. It reads one line from STDIN (a `.scm` path), interprets that program (remaining STDIN forwarded to it, output to STDOUT), must run every program in `test/`, and must be able to interpret **itself**.

**Solution shape** — Pure code authoring in the target Scheme dialect. `solve.sh` `cat`s a ~300-line `eval.scm`: cxr helpers, list utilities (length/append/map/assoc), an environment model (frames as vars/vals pairs, extend/lookup/set/define with `set-car!`), an `eval`/`my-apply` core handling quote/if/define/set!/lambda/begin/progn/let/cond, compound + primitive procedures, a primitive table (arithmetic, list ops, predicates, file I/O `fopen`/`fread`/`fgetchr`, `display`/`read`), and a driver that reads the filename and evaluates the file expression-by-expression. One file.

**Verifier** — pytest runs each `.scm` in `test/` and hidden `shadow_test/` both directly through `interp.py` and through `eval.scm`, normalizing a trailing "True", and asserts identical output; for a few files (05-simple, calculator, closures) it also runs the **metacircular** case (eval.scm interpreting eval.scm interpreting the test). All must match; asserts 0 failures. Binary 0/1.

**Difficulty drivers** — Must precisely match `interp.py`'s dialect semantics (special forms, mutation, I/O behavior, EOF handling) so outputs are byte-identical, and the evaluator must be self-hosting (correct enough to interpret its own ~300 lines within a 60s timeout). Graded on hidden `shadow_test` programs too, so it must be genuinely general, not overfit. Interpreter/PL domain knowledge.

**quanta attack points** — Code-authoring; `container_exec` to run `interp.py eval.scm` and diff outputs against the direct runs on the visible `test/` set. No TUI. Main risk: dialect edge cases (define scoping, cond/let, read/EOF) and self-interpretation performance, plus hidden shadow tests. The exit-code loop helps on visible tests but can't see `shadow_test`, so generality matters more than pass-until-green.

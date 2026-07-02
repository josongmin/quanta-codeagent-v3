---
task: overfull-hbox
category: debugging
difficulty: easy
tags: [latex, document-processing, combinatorial-optimization]
expert_min: 60
junior_min: 60
skill_class: DEBUG-FIX
terminal_native: med
docker_image: alexgshaw/overfull-hbox:20251031
---

# overfull-hbox

**Goal** — Make `main.tex` compile with pdflatex with zero "Overfull \hbox" warnings, editing ONLY `input.tex` and only by swapping words for their allowed synonyms in `synonyms.txt`. `main.tex` and `synonyms.txt` must stay unmodified.

**Solution shape** — `solve.sh` installs python3-pip, writes `fix_one_hbox.py` that parses `main.log` for Overfull line numbers + offending text, builds a synonym LUT, and substitutes one word per overfull box (with a small hard-coded good-substitution table as a stand-in for reasoning over the compiled output). Main loop: `pdflatex main.tex`, then `while grep -q Overfull main.log; do python3 fix_one_hbox.py; pdflatex main.tex; done` — iterative compile-substitute-recompile. ~80 lines.

**Verifier** — pytest (uvx). Reinstalls texlive, recompiles a pristine `main.tex` (guard). Asserts main.tex & synonyms.txt byte-unchanged; log contains "Output written on main.pdf"; log has no "Overfull \hbox"; and tokenizes original vs agent `input.tex` requiring identical tokens except allowed synonym swaps (punctuation prefix/suffix preserved). reward 0/1.

**Difficulty drivers** — Constrained combinatorial search: each substitution can create/remove overfull boxes elsewhere, so it's an iterate-until-clean loop. Requires reading pdflatex log format and respecting the "only synonyms in input.tex" edit constraint (verifier enforces exact token diff). Env needs a TeX distribution. Rated easy but the real skill is the compile-feedback loop.

**quanta attack points** — `container_exec` is the natural fit: run pdflatex, grep the log, edit input.tex, recompile — a textbook exit-code/log-driven "iterate until tests pass" loop, which strongly matches quanta's harness. Main failure risk is over-editing input.tex (breaking the token-diff guard) or a substitution loop that oscillates without converging. No interactive tooling; pty not needed.

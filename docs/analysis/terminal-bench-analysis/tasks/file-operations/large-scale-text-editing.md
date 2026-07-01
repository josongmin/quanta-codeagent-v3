---
task: large-scale-text-editing
category: file-operations
difficulty: medium
tags: [text-editing, large-scale-text-manipulation, vim, vim-macros]
expert_min: 40
junior_min: 90
skill_class: DATA-WRANGLE
terminal_native: high
docker_image: alexgshaw/large-scale-text-editing:20251031
---

# large-scale-text-editing

**Goal** — Transform `/app/input.csv` (1M rows) to byte-match `/app/expected.csv` using **keystroke-efficient Vim macros**. Save `/app/apply_macros.vim` defining exactly 3 non-empty distinct macros in registers a/b/c (< 200 total keystrokes), executed via `:%normal! @a/@b/@c`, run headlessly with `vim -Nu NONE -n -Es`.

**Solution shape** — Bash heredoc emitting the `.vim` script. Three `call setreg(...)` macros: (a) collapse whitespace around commas + trim line via `:s/`; (b) reverse the 3 fields `\1,\2,\3 -> \3,\2,\1`; (c) uppercase all fields (`\U..\E`), swap commas→semicolons, append `;OK`. Each macro is a `:s///` per line plus `j`, run over all lines with `:%normal!`. Ends `:wq`. One file produced (~10 lines of vimscript); the transform itself is regex-substitution logic, not Vimscript functions.

**Verifier** — pytest with anti-cheat: (1) script well-formed — only allowed commands, all 3 setreg + all 3 `:%normal! @x` + exit present; a keystroke whitelist **forbids** file-read/source/split/system/eval/`:!`/`:py` etc. (blocks reading expected.csv); (2) runs headless Vim, exits 0, then generates `expected.csv` AFTER the agent's script runs (so it can't be peeked); (3) SHA-256 of transformed `input.csv` == expected; (4) macros non-empty, pairwise distinct, total keystrokes < 200 (measured via `keytrans`). reward binary 0/1.

**Difficulty drivers** — Must reverse-engineer the exact transformation from input/expected, express it as pure Vim keystrokes (no scripting escape hatch — explicitly blocked), stay under a keystroke budget, AND survive on 1M rows within the timeout. Exact byte match on a huge file is unforgiving; keystroke-golf + anti-cheat make this genuinely terminal-native.

**quanta attack points** — This is the strongest `pty_*` case in the batch: the essence is Vim macro authoring, though the delivered script runs non-interactively via `container_exec` (`vim -Es -S`). An agent can iterate: write script, run headless Vim, diff against a self-generated expected. Main risk is the keystroke ceiling and the forbidden-command whitelist — the exit-code loop helps for correctness but the < 200 keystroke constraint requires deliberate golfing, not brute iteration.

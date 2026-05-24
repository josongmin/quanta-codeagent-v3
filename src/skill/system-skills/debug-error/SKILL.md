---
name: debug-error
description: Diagnose a failing test, exception, or stack trace by READING evidence before patching. Triggers on "debug this error", "what does this error mean", "fix this stack trace", "why is this failing", or any pasted exception / red CI log.
userInvocable: true
allowedTools:
  - Bash
  - Read
  - Grep
  - Edit
  - parse_test_failure
  - git_log
  - git_blame
category: skill
stability: stable
tools:
  - Bash
  - Read
  - Grep
  - Edit
  - parse_test_failure
  - git_log
  - git_blame
---

# debug-error — evidence-first error diagnosis

Engineering-task sibling of the CTK git-skill bundle (ADR-0111 family,
ADR-0134). The killer principle: **a fix unverified is a hypothesis**.
Most bad fixes come from patching the symptom you imagined instead of
the bug you measured.

## When this skill activates

- The user pastes a stack trace, a failing test, or a red CI log.
- The user says "debug this error" / "what does this error mean" /
  "fix this stack trace" / "why is this failing".
- A `babysit` / `loop-on-ci` loop hands off a failing assertion.

If none of these apply, do not silently pivot a normal task into a
debug session.

## P0 rules

1. **ALWAYS read the actual error text before guessing.** Quote the
   exact line — the verbatim error string + the topmost frame's
   `file:line`. Paraphrasing loses the only deterministic signal you
   have.
2. **ALWAYS read the file at `file:line` cited in the stack trace
   BEFORE proposing a fix.** The frame names a specific line; the bug
   is almost never one the model can guess without seeing the
   surrounding 20 lines.
3. **Search for "what changed".** Run `git log -p -<sha>..HEAD <file>`
   (or `git blame` on the failing line) — most production errors trace
   to a recent change. Bisecting in your head from memory is malpractice.
4. **Reproduce locally BEFORE editing.** Run the failing test or
   command and observe the failure with your own eyes. A fix
   unverified is a hypothesis; cite the reproduction command in the
   report.
5. **Cite evidence on every claim.** Every assertion ("this is null
   because…", "the loop runs twice because…") needs a `file:line`
   anchor AND an observed behavior (test output, log line, repro). No
   anchor + no observation = speculation.

## Procedure

1. **Isolate.** Quote the error text verbatim. Identify the topmost
   user-code frame (skip stdlib / node_modules). That `file:line` is
   the entry point.
2. **Reproduce.** Run the failing command (`bun test path/to/test.ts`,
   `node script.js`, etc.). If you cannot reproduce, STOP — you are
   debugging a ghost; ask the user for the exact command.
3. **Bisect.** `git log --oneline -20 <file>` and
   `git log -p -5 <file>` to see recent diffs touching the failing
   region. The bug is usually in one of the last 1-3 commits to that
   file.
4. **Hypothesize.** State the hypothesis as a falsifiable claim:
   "X is null at line Y because the caller at Z passes undefined."
   Cite each claim's evidence.
5. **Patch + reverify.** Make the smallest change that addresses the
   root cause (not the symptom). Re-run the reproduction command.
   Green = done; red = the hypothesis was wrong, go back to step 4.

## Common error families

- **`TypeError: Cannot read property 'X' of null/undefined`** — usually
  a missing nullish guard at the caller; read both the throwing line
  AND its caller frame before patching.
- **`UnhandledPromiseRejection` / dangling async** — a `.then()` /
  `await` is missing somewhere upstream; trace the promise chain back
  to the originating `async` function.
- **Circular import** (`undefined is not a function`, exports empty) —
  two modules import each other at top-level; one needs to defer the
  import to a function body or be restructured.
- **Off-by-one in a loop / slice** — re-read the loop bounds and the
  array length AT THE FAILING ITERATION (add a log, do not trust the
  invariant from memory).

## Outcome enum

- `fixed` — patch landed AND the reproduction command now passes.
- `root-cause-identified` — diagnosis cited file:line + observed
  behavior, but the fix is non-trivial / needs user decision.
- `cannot-reproduce` — repro failed; STOPPED + asked user for command.
- `blocked` — root cause is in code outside this repo (vendor bug,
  upstream regression); reported and stopped.

The string `complete` is forbidden until `fixed` or
`root-cause-identified` is true.

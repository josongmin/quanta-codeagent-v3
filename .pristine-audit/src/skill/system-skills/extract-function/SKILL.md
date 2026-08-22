---
name: extract-function
description: Extract a code block into a named function — survey callers first, name for intent, verify no regression. Triggers on "extract this into a function", "refactor to function", "pull this out", "DRY this up".
userInvocable: true
allowedTools: ["Read", "Grep", "Edit", "lsp_references", "scripted_replace"]
category: skill
stability: stable
---

# extract-function — caller-aware, intent-named refactor

Engineering-task sibling of the CTK git-skill bundle (ADR-0111 family,
ADR-0134). The killer principle: **extraction without caller-survey
is premature abstraction**. A function pulled out to serve one site
is often the wrong shape for the second site that should have used it.

## When this skill activates

- The user says "extract this into a function" / "refactor to
  function" / "pull this out" / "DRY this up".
- A reviewer comment flags duplicated logic across N sites.
- A `pr-review-canvas` pass surfaces a `mechanical` block that
  actually duplicates a `logic` block elsewhere.

If none of these apply, do not silently pivot a normal task into a
refactor.

## P0 rules

1. **Read all CALLERS (or near-duplicate sites) BEFORE extracting.**
   `lsp_references` on the symbol you're around; `grep` for the
   duplicated pattern. Extraction without caller-survey produces a
   signature that fits site 1 but breaks site 2.
2. **Name the function for its INTENT, not its implementation.**
   `parseAddress` not `splitOnCommaAndTrim`. The name is the
   abstraction contract — if it leaks "how", callers will rely on
   that "how" and the abstraction is dead at birth.
3. **First parameter is the SUBJECT (the object the function acts
   on). Boolean flags are a code smell.** `formatDate(d, true)`
   reads as a riddle; usually `formatDateShort(d)` and
   `formatDateLong(d)` are two honest functions. If the flag flips
   internal control flow, you have two functions in a trench coat.
4. **Single Responsibility — "and" in the docstring ⇒ split.** If
   the natural one-line description of the extracted function
   contains "and" or two unrelated verbs ("validate input AND send
   email"), the extraction is wrong; split into two.
5. **Verify NO regression after refactor.** Run tests + tsc /
   typecheck against the post-refactor tree. Refactor without
   verification is gambling — extraction is the kind of change
   whose breakage shows up at runtime, not at the diff.

## Procedure

1. **Identify the duplicate / extractable block.** Quote the
   verbatim lines you intend to lift; pin start/end with file:line.
2. **Survey callers.** `lsp_references` (for an existing function
   you're refactoring) OR `grep` for the duplicated pattern across
   the codebase. List every site — sites you didn't survey will
   surface as regressions.
3. **Name + signature.** Pick the intent-name (P0 rule 2). Decide
   parameters subject-first (P0 rule 3). If you wrote a boolean
   flag, go back and split (P0 rule 4).
4. **Extract.** Write the new function (place it at the smallest
   shared scope — same file if local, slice barrel if
   cross-module). Keep the body byte-equivalent to the original.
5. **Replace at call sites.** One site at a time; `scripted_replace`
   only when the pattern is mechanical and you have surveyed every
   match. Manual `Edit` for sites with structural differences.
6. **Verify.** `bun run typecheck && bun test` (or repo equivalent).
   Any new red is a regression introduced by THIS refactor; revert
   that site and reconsider the signature.

## Outcome enum

- `extracted` — new function authored, all N call sites replaced,
  typecheck + tests green; counts cited.
- `partial` — extraction done at M of N sites; M+1 site needs a
  different signature (surveyed mid-refactor); STOPPED + asked
  whether to split into two functions.
- `reverted` — extraction broke tests; rolled back; root cause
  cited.
- `blocked` — duplicated sites have semantically distinct intents
  despite syntactic similarity; STOPPED + reported.

The string `complete` is forbidden until `extracted` is true with
green verification.

---
name: explain-code
description: Explain what a function / module / file actually does by READING it, tracing callers, and surfacing history — never from memory or filename. Triggers on "explain this code", "what does X do", "walk me through this", "how does this work".
userInvocable: true
allowedTools:
  - Read
  - Grep
  - lsp_definition
  - lsp_references
  - git_log
  - git_blame
category: skill
stability: stable
tools:
  - Read
  - Grep
  - lsp_definition
  - lsp_references
  - git_log
  - git_blame
---

# explain-code — read-first, cite-everything explanation

Engineering-task sibling of the CTK git-skill bundle (ADR-0111 family,
ADR-0134). The killer principle: **READ FIRST — don't summarize from
memory or filename**. A confident-sounding explanation drawn from
training-data priors will mislead the user about THIS codebase, today.

## When this skill activates

- The user says "explain this code" / "what does X do" / "walk me
  through this" / "how does this work" / "what's this file for".
- A new contributor needs onboarding to a slice.
- A reviewer asks for clarification on a function before approving.

If none of these apply, do not silently pivot a normal task into an
explainer.

## P0 rules

1. **READ FIRST — never summarize from memory, the filename, or the
   import name.** Always open the actual file with Read before
   describing it. Training-data priors about a similarly-named
   library function are noise here.
2. **Find CALLERS.** Use `lsp_references` (or `grep` for the symbol)
   to show what depends on this. An explanation without callers
   describes a function in a vacuum; the user usually cares about
   how it fits.
3. **Find HISTORY.** Run `git log` on the file (and `git_blame` on
   the key lines) to surface WHY it exists. The intent in a commit
   message is often the most valuable single sentence about a
   function.
4. **Tier the explanation.** Lead with a 1-sentence purpose → then
   key data flow (inputs → transformations → outputs) → then
   important edge cases (errors, async, side effects). Do not dump
   line-by-line narration; tier so the reader can stop early.
5. **CITE `file:line` for every concrete claim.** "This validates
   the input" → "this validates the input at `parse.ts:42`". An
   uncited claim is a guess that survived editing.

## Procedure

1. **Read.** Open the target file in full (or the function + 20
   lines on either side). Note imports — they reveal the slice
   boundary.
2. **Identify entry points.** Which exports are public? Which are
   internal helpers? The explanation should center the public
   surface.
3. **Trace data flow.** For each public function: what comes in,
   what transformations happen (cite the key lines), what goes out
   (return value AND side effects).
4. **Find callers.** `lsp_references` on each exported symbol.
   Summarize: "called from N sites; primary caller is X for the
   purpose of Y".
5. **Check history.** `git log --oneline -10 <file>` for the
   recent shape; `git log -p -1 <file>` for the most recent intent;
   `git_blame` on lines that look surprising or load-bearing.
6. **Tier the explanation.** 1-sentence purpose → 3-5 bullet data
   flow → 2-3 edge cases. Cite file:line throughout. If the user
   asked a narrow question, answer narrowly — the tiered shape
   lets them ask follow-ups.

## Outcome enum

- `explained` — read-based explanation delivered with callers,
  history, and file:line cites.
- `partial` — top-level explanation delivered, but a sub-question
  needs lsp_definition / additional file reads the user should
  confirm priority on.
- `blocked` — file does not exist at the cited path; STOPPED +
  asked.

The string `complete` is forbidden until `explained` is true with
cited evidence.

---
name: localize-fault
description: Localize a fault to its edit location using a 3-stage evidence funnel (file → function → line). Triggers on "localize", "find the bug in", "where does X fail", "어디서 깨지는지", "fault localization", repro→fix tasks, and SWE-bench-style "fix this issue" requests. Ranks source text and test/build logs above search hits; never edits before source text confirms the owner.
userInvocable: true
allowedTools:
  - localize
  - read
  - grep
  - glob
  - lsp_document_symbol
  - lsp_references
  - diagnostics
  - test_runner
category: skill
stability: stable
tools:
  - localize
  - read
  - grep
  - glob
  - lsp_document_symbol
  - lsp_references
  - diagnostics
  - test_runner
---

# 3-stage fault localization (file → function → edit-location)

You are localizing a fault to the exact lines that need editing. This is the
Agentless-style funnel: do NOT jump to an edit on the first search hit. Each
stage uses **different evidence** and narrows the scope by one level.

The governing rule (Codex `may-20-codex-signal.md` signal hierarchy):

> Files are not chosen by query strings; they are retrieved by an evidence
> hierarchy. **Source text (10/10 trust) and build/test logs (8/9) outrank
> ripgrep hits (5/10 trust).** A `rg` hit *locates* a candidate; reading the
> source *proves* the owner. Never confirm an owner from grep alone.

## When this skill activates

Triggers (any one is enough):

- The user asks to "localize", "find the bug in", "where does X fail",
  "어디서 깨지는지", or gives a SWE-bench-style "fix this issue" task.
- A failing test / stack trace / error message is the starting point.
- The user pastes a repro and asks for the fix location.

If the user already named the exact file + function, skip to Stage 3.

## Stage 1 — FILE (which files own this fault)

Goal: a short ranked list of candidate files. Collect, do not confirm.

1. `localize` with the fault description as the query → ranked `path:line`
   candidates by BM25-lite IDF over query subtokens, with frame-tier penalty
   (`user` > `test` > `vendored`) and a small definition-pattern boost. Pass
   `verbose:true` to see per-candidate `score` and `tier` — helps
   disambiguate close runners-up before moving to Stage 2.
2. If the fault references a symbol/identifier, `grep` for it to see its
   distribution across the tree.
3. If the fault is a test/build failure, prefer the **failure log** —
   the file:line in a stack trace or assertion is a higher-trust signal than
   any search hit. Run `test_runner` (or read the provided log) FIRST when a
   repro exists.
4. `glob` only to enumerate when you need the module's file layout.

Output of Stage 1: 1–3 candidate files, each with WHY it is a candidate
(matched term / appeared in trace / imports the failing symbol). Do not yet
claim any file is the owner.

## Stage 2 — FUNCTION (which symbol within the file)

Goal: the specific function/class/method that owns the fault.

1. `read` the top candidate file(s). **This is the proof step** — source text
   is the highest-trust signal. A candidate is only an owner once you have
   read its relevant region.
2. `lsp_document_symbol` on the file → the full outline (functions / classes /
   methods + their line ranges). Use it to pick the symbol whose range covers
   the suspected behavior.
3. If a compile/type error is involved, `diagnostics` on the file gives the
   exact error line + message (build-log trust tier).
4. State a one-line **hypothesis**: "the fault is in `<symbol>` at
   `<file>:<line-range>` because `<source evidence>`."

Output of Stage 2: one owner symbol + its line range + the hypothesis. If
the source does not support any candidate, return to Stage 1 — do not force a
match (reject the "naming vibe" 2/10 signal).

## Stage 3 — EDIT-LOCATION (which exact lines)

Goal: the minimal line span to change, plus the blast radius.

1. `lsp_references` on the owner symbol → every call site. The fault may be at
   the definition OR at a caller passing the wrong thing; the references list
   tells you which.
2. `grep` for the symbol if LSP is unavailable (graceful fallback — same
   intent, lower precision).
3. Identify the **4 truth surfaces** before proposing an edit:
   - **type** — does the change keep types consistent?
   - **owner** — the definition file itself.
   - **wire** — caller files that must stay consistent.
   - **test** — which test exercises this path (or must be added).

Output of Stage 3: exact `file:line-range` to edit + the caller/test files
that share the blast radius. Hand this to `edit` / `scripted_replace`.

## Outcome enum

Terminate with exactly one of:

- `located` — owner symbol + edit lines proven by source text (Stage 2 read +
  Stage 3 references). Ready to edit.
- `narrowed` — candidate files found (Stage 1) but source has not yet
  confirmed an owner. Continue to Stage 2; do not edit.
- `uncertain` — no candidate survived source confirmation. Report the
  candidates inspected and why each was rejected; ask for a repro or more
  scope rather than guessing.

The string `found` / `done` is forbidden until source text (Stage 2) confirms
the owner. A ripgrep hit alone is `narrowed`, never `located`.

## Non-goals (do NOT do these)

- Do not edit on a Stage 1 search hit. `rg` locates; source proves.
- Do not skip Stage 2 read because the filename "looks right" (naming vibe is
  the lowest-trust signal — 2/10).
- Do not claim an owner from memory or a prior turn. Re-read the source.
- Do not parallelize Stage 3 across files that share write scope.
- Do not treat absence of a grep hit as proof of absence — dynamic / indirect
  references (reflection, string-keyed dispatch) won't show up.

## Source attribution

Mirrors the Agentless (Xia et al., 2024) file→function→edit-location funnel,
combined with Codex's signal-trust hierarchy
(`docs/reviews-codex-agent/may-20-codex-signal.md`,
`docs/reviews-codex-agent/may-20-codex-lsp.md`: "LSP is a disambiguator, not a
truth source"). quanta-v3 tool names (`localize` / `lsp_document_symbol` /
`lsp_references` / `diagnostics` / `test_runner`) replace the paper's generic
retrieval steps.

R-Phase9 (ADR-0115) replaced the prior flat term-count with BM25-lite IDF
(Robertson & Zaragoza, 2009) and applied the same `FrameTier` discipline
R-Phase8 introduced for `parse_test_failure`. The 3-stage funnel itself is
unchanged — `localize` remains a 5/10 candidate generator; source-text read
(Stage 2) still owns the proof.

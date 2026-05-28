# ADR-0410 — bash/edit/write describe steering + prompt-body few-shot examples

Status: Accepted — 2026-05-28
Supersedes: none
Extends: ADR-0003/0004 (cache-prefix invariant), ADR-0067 (prompt template
SOTA++), ADR-0068 (persona slot), ADR-0398 (atomic write + hash precondition)

## Context

Audit traces (and the smoke fixture battery) showed three recurring
mis-routings even though every necessary tool exists:

1. **`bash` for file ops** — the model reaches for `cat`/`sed`/`awk` when
   `read`/`grep`/`edit` would be cheaper, safer, and on the audit-and-reverse
   path (per-tool checkpoint, FS-jail, sandbox).
2. **`edit` for a new file** — old_string is empty / fuzzy-fails / never
   matches; the model retries instead of branching to `write`.
3. **`write` for a partial mutation** — the model overwrites the WHOLE file
   to change one line, then writes again to "fix" the side-effect.

The base system prompt's "Tool routing" table already names the correct tool
for each truth condition, but the per-tool `description:` strings (which the
provider's tool-choice mechanism reads as the primary routing signal) carry
no negative anchors — no "when NOT to use", no "use X instead".

### Evidence — competitors carry per-tool steering verbatim

Source: `.extracted_source/` (de-obfuscated competitor corpus — see the
[agent-analysis-corpus](memory:agent-analysis-corpus) memory file for
inventory; the analysis-only beautified trees are gitignored).

- **Codex `codex-rs 0.131.0-alpha.9`** — system skill `SHELL.md` and the
  `bash`/`apply_patch` tool definitions (L80-L120 of the per-tool prompt
  pack) both carry an explicit "use X instead" clause AND an inline example
  block. Their `apply_patch` description bans "use bash + sed to mutate
  files" verbatim.
- **Claude Code 1.7196.3 / 2.1.138** — `tools/Bash.ts`, `tools/Edit.ts`,
  `tools/Write.ts` each ship a "when not to use" paragraph in the
  description AND two `<example>` blocks per tool (positive + avoidance).
  The 2.1.138 build's `Bash.ts` flags `cat`/`sed`/`awk` as routing
  anti-patterns.
- **Cursor 3.2.16** — `.cursor/rules` and the `agent` tool definition
  declare the same "edit beats sed" pattern under the
  `tool-choice-discipline` rule.

Three independent vendors converging on the same shape is the empirical
ceiling we are pulling toward.

## Decision

### 1. Bash describe — steer toward `read`/`grep`/`edit`

`src/tool/bash/index.ts` `description:` field gains a steering clause:

> Prefer `read`, `grep`, and `edit` for file inspection and modification —
> use bash ONLY when the task finishes in a single shell command (file
> search via rg/fd, diff/git inspection, scoped exec). Do NOT use bash for
> cat/sed/awk over files — `read` covers file reading and `edit` covers
> targeted in-file string replacement, with proper sandbox and reversal
> semantics.

The legacy "Run a shell command (bash). Returns combined stdout/stderr and
exit code. Non-zero exit is reported, not thrown." sentence is preserved
verbatim — operator runbooks rely on it.

### 2. Edit describe — when-not-to-use clause

`src/tool/edit/index.ts` `description:` gains:

> Do NOT use edit to create a new file — use `write` instead. Do NOT use
> edit when old_string is not unique in the file — include more
> surrounding context to make it unique, or set `replace_all: true` for
> intentional bulk replacement.

The existing "Exact string replacement in an existing file. old_string
must match verbatim." sentence is preserved.

### 3. Write describe — when-not-to-use clause

`src/tool/write/index.ts` `description:` gains:

> Do NOT use write for partial mutation of an existing file — use `edit`
> instead. Multiple consecutive writes to the same file is almost always a
> wrong pattern (you are overwriting your own previous write); read the
> current bytes and use `edit` instead.

The existing "Write a file, creating or fully overwriting it. Creates
parent dirs." sentence is preserved.

### 4. Prompt-body — TWO `<example>` blocks

`src/agent/prompt-body.ts` `BODY_AFTER_PERSONA` gains TWO anchor examples
spliced AFTER the "Tool routing" matrix (and BEFORE the prompt-pack splice
where the R-* rules ride):

- **Positive** — "User wants to inspect `buildSystemPrompt()` → grep, then
  read the narrow span" — names `read`/`grep` as the chosen path.
- **Avoidance** — "User wants to rename `foo` → `bar` in a file. Wrong
  route: `bash -lc \"sed -i ... s/foo/bar/g ...\"`. Right route: `read`
  then `edit`." — names the bash+sed anti-pattern verbatim.

Two examples is the empirical sweet spot — the Codex SHELL.md and Claude
Code 2.1.138 `tools/Bash.ts` both ship two per tool. Three+ bloats the
cached prefix; one is too weak an anchor.

## Invariants

- **Cache-prefix byte-stability** (ADR-0003/0004) — the examples are pure
  literal strings in `prompt-body.ts`. No `Date.now`, no `Math.random`,
  no env reads. `buildSystemPrompt()` remains byte-identical across calls
  (hellgate asserts 50 idempotent calls).
- **No regression on the existing routing rules** — the R-SEARCH-FIRST /
  R-READ-FAILURE / R-NO-THRASH / R-NO-SHIM / R-ENV / R-STOP-ENV rules ride
  in `prompt-rules/core.ts` (the prompt-pack splice). They appear AFTER
  the examples because the examples sit at the END of `BODY_AFTER_PERSONA`
  and the prompt-pack splices BETWEEN `BODY_AFTER_PERSONA` and
  `BODY_AFTER_PROMPT_PACK`. The existing snapshot test
  (`prompt-rules-snapshot.test.ts`) order constraint
  ("Tool routing < [R-SEARCH-FIRST] < Honesty rail") still holds because
  the examples sit between "Tool routing" and "[R-SEARCH-FIRST]".
- **Tool descriptions stay one-paragraph** — each description grows by
  ~60-80 tokens (within the empirical 200-token cap before tool choice
  mass dilutes; Codex/Claude both stay under it).
- **No semantic change to tool behavior** — only `description:` strings
  change in the tool files. Schemas, execute, hitlTier are untouched.

## Tests

`tests/unit/tool-steering-and-prompt-examples-hellgate.test.ts` — 19 cases,
89 expect() calls covering:

- Each `description:` carries the verbatim steering / when-not-to-use
  phrases (substring + regex matches).
- Each `description:` retains its pre-existing contract sentence (so
  operator-facing docs don't silently drift).
- Prompt-body carries exactly TWO `<example>` blocks (open + close count).
- Examples sit AFTER "Tool routing" and BEFORE "Honesty rail".
- 50 idempotent calls to `buildSystemPrompt()` produce identical output
  (cache-prefix byte-stability).
- Anti-signal seven names + Policy stack L1-L9 + Verification report
  scaffold remain unchanged (negative invariants).

Existing prompt tests (`prompt-system.test.ts` + `prompt-rules-snapshot.
test.ts` — 66 cases, 338 expect() calls) still pass — the new content sits
in the cached prefix WITHOUT disturbing any position-stable assertion.

## Out-of-scope

- The `description:` text is NOT translated to Korean — competitors all
  ship English; mixing in mid-prompt CJK would split tokenization caches.
- No new tool, no new `Tool` field. Wire-up is description-only.
- No change to `prompt-rules/{core,benchmark,assistant,...}.ts` —
  pack-selection variants inherit the new examples through the shared
  `BODY_AFTER_PERSONA` head.

## Alternatives considered

- **Add the steering to `prompt-rules/core.ts` (the R-* rules block)** —
  rejected. The R-* IDs are model-discipline rules; per-tool routing
  belongs on the tool itself so the provider's tool-choice gating sees it
  during selection, not just during reasoning.
- **One example, not two** — rejected. Codex/Claude empirically converge
  on two (positive + avoidance); one alone is a weaker anchor and routes
  cleanly only ~70% of the time in their A/B traces.
- **Replace the legacy sentences instead of appending** — rejected.
  Operator runbooks grep for "Run a shell command" / "Exact string
  replacement" / "Write a file" — removing them would silently break
  docs.

## Closeout

- Files changed: `src/tool/bash/index.ts`, `src/tool/edit/index.ts`,
  `src/tool/write/index.ts`, `src/agent/prompt-body.ts`.
- Files added: `tests/unit/tool-steering-and-prompt-examples-hellgate.
  test.ts`, this ADR.
- Existing snapshot test (`prompt-rules-snapshot.test.ts`) — no
  modification needed: the new section rides BETWEEN "Tool routing" and
  the R-* rules, so the existing "Tool routing < [R-SEARCH-FIRST] <
  Honesty rail" ordering still holds without any expectation rewrite.
- ADR collision check — 0406-0409 are user in-flight (composition-root /
  approval / observability-pane / compaction-visibility); per the
  user-deference renumber policy we land on 0410 (next free).
- Verification: `bun test` on the hellgate file + the two existing prompt
  suites: 85 pass / 0 fail / 427 expect() calls.

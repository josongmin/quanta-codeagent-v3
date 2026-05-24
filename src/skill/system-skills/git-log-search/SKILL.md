---
name: git-log-search
description: Search git history with pickaxe (-S), regex (-G), author filter, time filter, or path filter. Triggers on "when did X get added", "find commits matching pattern", "who wrote X", "git history search", "code archaeology".
userInvocable: true
allowedTools: ["Bash", "Read"]
category: skill
stability: stable
---

# git-log-search — code archaeology via git log

When the user asks "when was X added/removed?" / "who wrote this?" / "find
commits matching Y" — git log search is the right tool. Pickaxe (`-S`) finds
commits where a string's COUNT changed; regex (`-G`) finds commits where any
diff line matches a pattern. Author/since/path filters compose with both.

Research-grounded as a SKILL (not a tool): Cursor exposes `blame_by_file_path`
as an atomic tool but its history-search workflows live in CTK skills via
`git`/`gh` shell — exploratory queries need user iteration, not single-shot
execution (see `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧).

## When this skill activates

- "when did `<var>` appear?" / "history of `<function>`"
- "who added this code?" / "blame this section" (for history beyond `git blame`)
- "find commits with pattern Y" / "search history for X"
- "code archaeology" / "git log search"
- "what did `<author>` change last week?" / "commits since `<time>`"

## P0 rules

1. **PICKAXE = string COUNT change.** `-S"foo"` matches commits where the
   count of "foo" occurrences in the diff is non-zero (added OR removed).
   Use this for tracking specific identifiers (function names, constants).
2. **REGEX = diff line match.** `-G"foo.*bar"` matches commits where any
   diff line matches the regex (added OR removed). Use this for patterns.
3. **CAP OUTPUT.** Default `-n 50`. If the user wants more, raise it
   explicitly. `git log --all -S` on a 10K-commit repo without `-n` is slow
   and floods context.
4. **DETERMINISTIC ENV.** Always invoke with the env-hygiene quartet
   (ADR-0105): `GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat GIT_TERMINAL_PROMPT=0
   LC_ALL=C git log …`. This disables lock contention, pager TTY assumption,
   credential prompts, and locale-sensitive ordering.
5. **US-SEPARATOR FORMAT.** Use
   `--pretty=format:"%H%x1f%an%x1f%ai%x1f%s"` (record sep = US `\x1f`) so
   output parses safely even when commit messages contain shell-special
   characters (tabs, quotes, pipes).

## Procedure

1. **Identify intent.** Which search mode does the user want — pickaxe,
   regex, author, since, or path? Often a combination.
2. **Build command.** Always via the Bash tool:
   ```sh
   GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 LC_ALL=C \
     git log --all -n 50 --pretty=format:"%H%x1f%an%x1f%ai%x1f%s" \
       [-S"<pickaxe>" | -G"<regex>"] \
       [--author="<name>"] \
       [--since="<time>"] \
       [-- <path>]
   ```
3. **Parse output.** Split each line by `\x1f` →
   `{sha, author, iso_date, subject}`. Drop empty trailing lines.
4. **For each commit (top 5–10), optionally fetch context.** Bash
   `git show <sha> -- <path>` to surface a 3–5 line snippet of the actual
   change. Skip this for large result sets.
5. **Render the answer.** Numbered list, oldest-first by default, with
   `file:line` citations when `git show` was used. Cite the search command
   so the user can re-run it.

## What NOT to do

- Don't use `--all` without `-n` cap — flood + slow.
- Don't use pickaxe with very short strings (1–2 chars) on large repos —
  cost is O(history × diff size); the string `=` will match millions.
- Don't surface raw `git log -p` output without parsing — unified diff is
  unreadable for the model and burns context.
- Don't run on a bare worktree without `--git-dir`, and don't `cd` between
  Bash calls (cwd resets per call) — pass absolute paths.

## Common queries

- "When was `parseConflicts` added?" →
  `-S"parseConflicts"` then `git show <oldest sha>`.
- "Find commits with TODO comments since 3 months ago" →
  `-G"TODO"` + `--since="3 months"`.
- "What did Alice change in `src/agent` last week?" →
  `--author="Alice" --since="1 week" -- src/agent`.
- "Who deleted the `legacyHandler` function?" →
  `-S"legacyHandler"` then inspect commits where COUNT went from N → 0.

## Outcome

- `found` — at least one matching commit, parsed and rendered.
- `empty` — search syntactically valid but zero hits. Report the exact
  command run so the user can broaden the query.
- `blocked` — invalid input (e.g. pickaxe string is single regex
  metachar, working tree is bare without `--git-dir`). Report and ask.

The string `complete` is forbidden until the search returns `found` or
`empty` with the command echoed back.

---
name: blame-section
description: Multi-line / section-scoped `git blame` workflow. Wraps the existing `git_blame_heatmap` tool's `start_line`/`end_line` range form (ADR-0096), groups by author + commit, surfaces the top-3 authors with line counts, cites at least 2 specific commit SHAs (most-touched + most-recent), and distinguishes ORIGINAL author (first commit to introduce the lines) vs RECENT editor (last commit to modify). Triggers on "blame this section", "who wrote these lines", "section ownership", "line range blame".
userInvocable: true
allowedTools: ["Bash", "Read", "git_blame", "git_blame_heatmap"]
category: skill
stability: stable
---

# blame-section — multi-line ownership over a region

When the user says "who wrote this section?" / "git blame these lines" /
"section ownership", they want ownership scoped to a RANGE, not a whole
file. This skill wraps the existing `git_blame_heatmap` tool's range form
(`start_line`/`end_line` — ADR-0096 expanded the tool to accept ranges) and
adds the workflow shape: author grouping, top-3 surfacing, ≥2 SHA citations,
original-author vs recent-editor distinction.

Research-grounded as a SKILL (not a new tool): Cursor exposes
`blame_by_file_path` as the atomic ownership tool, but ownership-narrative
workflows (the "who should review this PR" framing in `pr-review-canvas`,
the moved-code attribution in `make-pr-easy-to-review`) live in CTK skills
(see `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧). Multi-line
section ownership is the same shape — one tool call, but the interpretation
(group / rank / pickaxe-for-origin) is workflow logic the user iterates on.

Sibling of `git-log-search` (ADR-0172, archaeology via `git log -S` / `-G`)
and the CTK git bundle (ADR-0111 babysit / pr-review-canvas / etc).

## When this skill activates

- "who wrote these lines?" / "blame this section"
- "section ownership" / "line range blame"
- "who owns this function?" (when the user names a file + function or
  cites a `file:line-line` range)
- A `pr-review-canvas` walkthrough wants ownership annotation on a hunk.

If the user wants whole-file ownership distribution, the `git_blame_heatmap`
tool ALONE (no `start_line`/`end_line`) suffices — this skill is the
range-narrowed workflow.

## P0 rules

1. **USE the existing `git_blame_heatmap` tool with `start_line`/`end_line`.**
   ADR-0096 expanded `git_blame_heatmap` to accept ranges via
   `start_line`/`end_line` — both must be provided together (Zod refinement
   in the tool's input schema enforces this), and `end_line >= start_line`.
   Verify by reading `src/tool/git/blame-heatmap.ts` if you need to confirm
   the input shape before invoking. Do NOT shell out to raw `git blame -L`
   when the tool exists — the tool already wires ADR-0105 env hygiene +
   the porcelain parser.
2. **GROUP RESULT BY author + commit; surface TOP-3 authors with line
   counts.** `git_blame_heatmap`'s output is per-author line counts; this
   skill's job is to rank, take top 3, and emit `<author> — <lines> lines
   (<pct>%)`. Do not dump the raw heatmap and ask the user to interpret.
3. **CITE AT LEAST 2 SPECIFIC COMMIT SHAs.** The most-touched commit
   (largest `count` in the porcelain output for the range) AND the
   most-recent commit (largest `author-time` for any line in the range).
   These are TWO different questions ("who shaped this code?" vs "who
   touched it last?") and the user usually wants both. Use `Bash` →
   `GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 LC_ALL=C
   git log -1 --pretty=format:"%H %ai %an %s" <sha>` for each.
4. **DISTINGUISH ORIGINAL author vs RECENT editor.** `git blame` shows the
   LAST commit to modify each line — i.e. the recent editor. The ORIGINAL
   author (who first introduced the lines) requires `git log -L:<funcname>:<file>`
   if the range is a function, OR `git log -S<unique-token-in-range> --reverse`
   to pickaxe the line's earliest introduction. Run the pickaxe ONLY if
   the user asks "who originally wrote this" — it's slow (full-history
   scan) and most queries want the recent editor, which the heatmap
   already gives.

## Procedure

1. **Resolve range.** Confirm `file`, `start_line`, `end_line` from the
   user request. If they cite a function name instead of a range, `Read`
   the file to find the function's line bounds first.
2. **Run blame_heatmap.** Invoke `git_blame_heatmap` with
   `{file, start_line, end_line, n: 10}`. The tool runs
   `git blame --line-porcelain -L <start>,<end> -- <file>` and returns
   per-author counts (top N).
3. **Identify top-3 authors.** From the heatmap output, take the top-3
   rows by line count. Emit `<author> — <lines> lines (<pct>%)`.
4. **Cite ≥ 2 SHAs.** Run `Bash` `git log -1 --pretty=format:"%H %ai %an %s"`
   for (a) the commit with the highest count in the range and (b) the
   most-recent commit by author-time. If the user asked "who originally
   wrote this", ALSO run `git log -S"<unique-token>" --reverse -n 1`
   pickaxe to find the first introduction. (Pickaxe is slow — skip unless
   asked.)

## What NOT to do

- Don't omit `start_line`/`end_line` and run whole-file blame — that
  defeats the purpose; the user asked about a SECTION.
- Don't dump the raw `git blame --line-porcelain` output — group it.
- Don't conflate "recent editor" with "original author". `git blame` shows
  the former by default; pickaxe is needed for the latter. Stating
  "<X> wrote this code" when blame only shows the last whitespace fix is
  a load-bearing factual error.
- Don't run pickaxe (`git log -S` / `-G`) on the whole repo without
  `-- <file>` scoping when the user only cares about one file — pickaxe
  cost is O(history × diff size).
- Don't shell out to `git blame` raw when `git_blame_heatmap` exists; the
  tool already wires ADR-0105 env hygiene + parses porcelain output
  safely.

## Common queries

- "Who wrote lines 80-120 of `src/agent/loop.ts`?" →
  `git_blame_heatmap` with `start_line:80, end_line:120` → top-3 authors
  + 2 SHAs (most-touched + most-recent).
- "Section ownership of the `dispatch()` function" → `Read` to find the
  function bounds → heatmap on the bounds → top-3.
- "Who originally wrote this hunk?" → heatmap for recent editors +
  pickaxe `git log -S"<unique-token>" --reverse -n 1` for original.

## Outcome

- `attributed` — top-3 authors emitted with line counts AND ≥2 SHAs
  cited (most-touched + most-recent), original-vs-recent distinction
  stated.
- `range-empty` — the range exists but blame returned no lines (e.g.
  range past EOF). Report the tool's `line out of range` error.
- `blocked` — file is not in the git index (untracked / ignored).
  Report and ask whether to `git add` first.

The string `complete` is forbidden until `attributed` is reported.

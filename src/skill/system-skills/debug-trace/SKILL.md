---
name: debug-trace
description: Orchestrate "this crashed" / "investigate this error" debugging workflows. Parses raw error text deterministically via the `parse_test_failure` tool, reads every cited file:line frame, distinguishes caller vs root-cause frames, and produces a ranked hypothesis with one-line cause + one-line fix. Triggers on "debug this", "investigate crash", "what failed", "trace this error", "stack trace analysis".
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "parse_test_failure", "file_tree_summary"]
category: skill
stability: stable
---

# debug-trace — orchestrate crash/error investigation

When the user says "this crashed" / "what's the stack" / "investigate this
error", this skill bundles the four steps a disciplined diagnosis takes:
collect raw error text, parse it deterministically, read every cited frame,
form a hypothesis with file:line + one-line cause + one-line fix.

Research-grounded as a SKILL (not a tool): Cursor's CTK exposes per-action
tools (`gh pr checks`, `blame_by_file_path`) but its workflow-shaped tasks
(`fix-merge-conflicts`, `loop-on-ci`) live in skills because they orchestrate
several tools through a decision tree the user iterates on (see
`docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md` §⑧). Crash
investigation is workflow-shaped — the model picks which frame to read first,
when to grep for siblings, and when to stop hypothesizing.

Sibling of `explain-stack-trace` (read-only narrative; no fix proposal) and
`debug-error` (broader debugging incl. reproduction). This skill is the
"investigate FIRST, propose fix LAST" middle ground.

## When this skill activates

- "debug this" / "investigate this crash" / "what failed?"
- "trace this error" / "stack trace analysis"
- User pastes raw exception output and asks for diagnosis.
- A `babysit` / `loop-on-ci` loop surfaces an unfamiliar exception.

If the user wants a plain-English narrative without a fix, defer to
`explain-stack-trace`. If they want full reproduce-and-patch, defer to
`debug-error`.

## P0 rules

1. **ALWAYS parse RAW error text FIRST.** Use the `parse_test_failure` tool
   (deterministic, framework-aware — pytest / python traceback / jest /
   vitest / bun / go test / cargo) BEFORE grepping or guessing. The tool
   extracts framework + per-frame `{file, line, function}` and ranks
   user-code frames above test frames above vendored noise. Skipping this
   step and pattern-matching against the error string is the #1 source of
   wrong root-cause attributions.
2. **READ the FILE at each frame.** Do not reason from the error message
   alone. Open `file:line` via the `Read` tool with a 20-line window. The
   surrounding code disambiguates "null because no init" vs "null because
   guard fell through" vs "null because async race" — all three throw the
   same `TypeError`.
3. **DISTINGUISH caller frame vs root-cause frame.** The stack trace's
   TOPMOST user-code frame (after stdlib / node_modules / site-packages
   are stripped) is the most likely root cause; the bottom-most user-code
   frame is the caller that triggered it. Read BOTH before deciding. Assert
   the root cause by reading its file, not by trusting the heuristic.
4. **QUOTE the actual exception message verbatim.** Do not paraphrase.
   "undefined is not an object (evaluating 'x.y')" is NOT the same diagnostic
   as "value missing on x" — the verbatim phrase tells you whether `x` is
   undefined or `y` is missing on `x`. Paraphrasing loses load-bearing detail.
5. **HYPOTHESIS shape = `file:line` + one-line cause + one-line proposed fix.**
   If 3 plausible causes survive frame-reading, LIST all 3 ranked by
   likelihood with their independent evidence. Single-candidate hypotheses
   that omit alternatives are how confirmation bias ships.

## Procedure

1. **Collect.** Quote the user's raw error text verbatim into a code block.
   If it spans more than 50 lines, ask which exception (chained tracebacks
   commonly stack 3-5 deep). Identify the language ecosystem from the
   exception class shape (`TypeError`, `pytest.fail`, `panic:`, `goroutine`).
2. **Parse.** Invoke the `parse_test_failure` tool with the raw text. Capture
   its ranked frame list (user-code first). If the tool returns 0 frames,
   the input is not a recognized framework — fall back to manual line-by-line
   regex of `file:line:` patterns and proceed with reduced confidence.
3. **Read frames.** For each user-code frame (top 3 max), `Read` the file
   with offset = line - 10, limit = 20. Optionally `file_tree_summary` on
   the directory if the frame's role (production vs test vs fixture) is
   unclear. `Grep` for the failing identifier across the codebase IF and
   ONLY IF the read window doesn't show its origin.
4. **Hypothesize.** State the hypothesis as: `<file>:<line> — <one-line
   cause> — <one-line proposed fix>`. If multiple causes are plausible after
   reading, list each with independent evidence. STOP — this skill does NOT
   apply the fix. Hand off to `debug-error` for reproduce+patch.

## What NOT to do

- Don't propose a fix without reading the frame's file — the model's prior
  about what the function does is wrong often enough that bypassing the
  `Read` step ships wrong patches.
- Don't skip `parse_test_failure` because "the error is obvious". The tool's
  framework-aware ranking surfaces frames the eye skips (e.g. `pytest`
  hides the user assertion inside `_pytest/assertion/rewrite.py`).
- Don't paraphrase the exception message. Quote it.
- Don't claim "this is the cause" with a single hypothesis when 2-3 frames
  could each explain the failure — rank them with evidence instead.
- Don't apply the fix in this skill. That's `debug-error`'s scope.

## Common queries

- "What does this `TypeError: undefined is not an object` mean?" → parse →
  read topmost user frame → quote exception → hypothesis.
- "Investigate this crash" (pasted goroutine panic) → parse (cargo / go
  recognizer) → read root frame + caller frame → distinguish.
- "Why is this test failing?" (pytest output) → parse (pytest recognizer
  ranks the `assert` line above the rewrite-frame noise) → read assertion
  + the line(s) it references → 1-3 ranked hypotheses.

## Outcome

- `hypothesis-formed` — one or more ranked `file:line + cause + fix`
  candidates emitted, evidence cited per candidate.
- `parse-failed` — `parse_test_failure` returned 0 frames AND manual
  fallback couldn't extract a `file:line`. Report the raw text and ask for
  the exact error source.
- `blocked` — frames cite files outside the working repo (vendor, system
  library). Report and ask whether to chase upstream.

The string `complete` is forbidden until `hypothesis-formed` is reported
with at least one `file:line + cause + fix` triple.

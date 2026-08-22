---
name: explain-stack-trace
description: Pure read-only stack-trace explainer. Parses the trace deterministically via the `parse_test_failure` tool, identifies the exception class semantics in the language ecosystem, walks the trace bottom-up (where it crashed → outer caller → user-code boundary), and renders a single plain-English paragraph. Does NOT propose a fix — defer to `debug-trace` for that. Triggers on "explain this stack", "what does this error mean", "translate this trace".
userInvocable: true
allowedTools: ["Read", "Grep", "parse_test_failure"]
category: skill
stability: stable
---

# explain-stack-trace — narrative-only trace translator

When the user says "explain this stack trace" / "what does this error tell
me" / "translate this trace", they want a one-paragraph plain-English
summary, not an action plan. This skill is intentionally read-only and
intentionally **does not** propose a fix — that is `debug-trace`'s job.

Research-grounded as a SKILL (not a tool): Cursor's CTK demonstrates that
narrative / framing tasks (`pr-review-canvas`'s reviewer walkthrough,
`make-pr-easy-to-review`'s reviewability framing) live in skills because the
output is prose shaped by the user's evolving question, not a fixed
structured payload (see `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-git.md`
§⑧). A trace explainer is the same — the prose adapts to whether the user
needs language-ecosystem context, an unfamiliar exception class glossed, or
just the bottom-up walk summarized.

Sibling of `debug-trace` (hypothesizes a fix) and `debug-error` (reproduces +
patches). When the user wants action, cite those skills and stop.

## When this skill activates

- "explain this stack trace" / "explain this error"
- "what does this error mean?" / "translate this trace"
- User pastes a trace and asks for understanding (not a patch).
- A subagent / planner wants a one-paragraph framing before deciding
  whether to spawn `debug-trace`.

If the user says "fix this" / "patch this" / "what's wrong", that's
`debug-trace` or `debug-error` — explain-stack-trace explicitly stops short
of an action proposal.

## P0 rules

1. **PARSE FIRST.** Use the `parse_test_failure` tool BEFORE guessing.
   It's deterministic + framework-aware (pytest / python / jest / vitest /
   bun / go / cargo); guessing what's a frame from a regex is the #1
   source of trace mis-explanations.
2. **IDENTIFY the exception class semantics in THIS language ecosystem.**
   A Python `KeyError` is dict-only; a JS `TypeError` covers null deref +
   non-function call + non-iterable iter; a Go `panic` is `nil` pointer or
   index-out-of-range or explicit `panic()` — meanings DIVERGE per language
   and the user's question implicitly assumes you know which one. Read at
   least one frame to confirm the ecosystem if the exception class is
   ambiguous (e.g. `Error:` could be JS, Java, Rust).
3. **WALK the trace BOTTOM-UP.** Where it crashed (innermost frame) →
   outer caller → user-code boundary (where stdlib / framework / vendored
   code ends and the user's code begins). The bottom-up walk is the order
   the runtime built the trace; the top-down walk is the order the user
   called functions — both are valid but bottom-up is what an
   explanation should narrate because it tells the actual causation story.
4. **ONE paragraph. NO proposed fix.** This skill's contract is
   read-only narrative. If a fix would be obvious, end the paragraph with
   "for an actionable hypothesis, invoke `debug-trace`" — do not include
   the hypothesis here. Distinct from `debug-trace`; users invoke this one
   when they want understanding, not action.

## Procedure

1. **Parse.** Invoke `parse_test_failure` with the raw text. Capture the
   ordered frame list. If 0 frames, fall back to manual `file:line:`
   scanning and proceed with reduced confidence.
2. **One-line per frame (bottom-up).** For each user-code frame (top 3-5),
   `Read` a 10-line window and write one sentence: "In `<file>:<line>`,
   `<function>` did X". Skip vendored / stdlib frames unless they're the
   ONLY frames (e.g. a stack of pure framework code → name the framework
   and stop).
3. **Render one paragraph.** Combine: exception class + ecosystem
   meaning + bottom-up causation + user-code boundary frame. Cite each
   frame as `file:line`. End with the `debug-trace` handoff sentence if
   the user might want a fix. STOP — do not propose a fix yourself.

## What NOT to do

- Don't propose a fix. (Repeated because this is the #1 violation mode —
  the model wants to be helpful and slips into hypothesizing. `debug-trace`
  handles that.)
- Don't skip `parse_test_failure` because "the trace is short". Short
  traces still mis-parse when the runtime injects synthetic frames
  (`Promise.then`, `async_hooks`, pytest assertion rewrite).
- Don't narrate every frame — vendored / stdlib frames are noise. The user
  wants causation, not a frame dump.
- Don't paraphrase the exception class name; use it verbatim (it's the
  user's anchor for googling later).
- Don't speculate about WHY the exception was thrown beyond what the
  cited code shows. "Probably a race" without evidence is a `debug-trace`
  hypothesis, not an explanation.

## Common queries

- "Explain this Python `KeyError`" → parse (python traceback recognizer)
  → identify KeyError-on-dict → bottom-up walk → one paragraph.
- "What does this trace mean?" (JS unhandled promise rejection) → parse
  (jest/bun/node recognizer) → identify `UnhandledPromiseRejection`
  semantics → identify the async boundary frame → narrate.
- "Translate this panic" (Go) → parse (go test / runtime panic) →
  identify nil-deref vs index-OOR vs explicit panic → narrate caller
  chain in one paragraph.

## Outcome

- `explained` — one-paragraph narrative produced, every cited frame has
  a `file:line` anchor, no fix was proposed.
- `parse-failed` — `parse_test_failure` returned 0 frames AND manual
  fallback couldn't extract anchors. Report raw text and ask source.
- `out-of-scope` — user asked for a fix mid-flow. Cite `debug-trace`
  and stop.

The string `complete` is forbidden until `explained` is reported (with
no fix proposal in the body).

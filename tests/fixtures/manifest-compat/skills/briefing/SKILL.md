---
name: briefing
description: Use when the user wants a complete session wrap-up, executive summary, CTO report, leadership brief, or rich closeout note covering what was done in this session, why it mattered, what changed in code/docs/tests, what was verified, what remains, and what risks or next actions should be highlighted.
---

# Briefing

## Overview

This skill turns the current Codex session into a complete, leadership-ready report without dropping important work that happened across exploration, patching, verification, RCA, or documentation.

Use it when the user asks for a session recap, CTO report, executive brief, rich handoff, or "what did we actually do in this session?" style summary and wants more than a short status update.

## Trigger Conditions

Use this skill when the request is about the current thread or session and the user wants any of:

- A full session wrap-up
- A CTO, exec, or leadership report
- A handoff-quality summary of work completed
- A "what changed / what got fixed / what remains" recap
- A rich report that must include code, tests, docs, RCA, and residual risk
- A session summary where partial verification or uncertainty must remain explicit
- A retrospective that should include difficulty, time spent, lessons learned, or operator reflection

Do not use this skill for a normal short progress answer. Use ordinary prose for lightweight status updates.

## Workflow

### 1. Set the reporting target

Decide who the report is for:

- `CTO / leadership`: strategy, architecture, risks, signoff state, residuals
- `handoff / team`: execution detail, changed files, tests, next steps
- `self-audit`: exact delta, patch intent, evidence, residual debt

If the user names the audience, optimize for that audience. If they do not, default to CTO/leadership style with enough technical grounding to survive follow-up.

### 2. Gather the session record first

Build the report from the session itself before reaching for broad repo state:

- What the user asked for and how scope changed over time
- What you inspected
- What you patched
- What you verified
- What you attempted but did not finish
- What you proved false during RCA
- What remains open

Prefer this evidence order:

1. Current thread history
2. Files actually touched or cited in the thread
3. Verification commands and outputs from the session
4. Narrow repo inspection only when needed to close a gap in the recap

Never present a repo-wide claim that was not actually established in this session.

### 3. Reconstruct the work by lane

Split the session into concrete lanes. Common lanes:

- code cleanup
- structural refactor
- compatibility / legacy removal
- tests / owner-local proof
- gate / CI wiring
- documentation / handoff update
- verification / RCA
- residual blockers

For each lane, extract:

- Goal
- Key decisions
- Concrete changes
- Evidence
- Current state: `done`, `partial`, `pending`, `blocked`, or `validation pending`

### 4. Preserve honesty

When verification is partial:

- Say what is verified
- Say what is inferred
- Say what is still pending
- Separate environmental failures from code failures
- Do not collapse "compile tail still running" into a done claim

When docs were stale and code was treated as the truth layer, say that explicitly.

### 5. Produce the report in the right shape

Default CTO report shape:

1. `Executive Summary`
2. `What We Changed`
3. `Why It Matters`
4. `Verification and RCA`
5. `Open Risks / Residuals`
6. `Recommended Next Actions`

If the user asks for a richer or "푸부한" report, expand each section with concrete detail and file-backed examples.

When the user asks for retrospective depth, extend the default shape with:

7. `Difficulty and Effort`
8. `Retrospective`
9. `Operational Lessons`

## Required Content

Unless the user explicitly asks for less, include all of:

- The original problem framing in this session
- How the scope evolved
- Every major code or doc lane worked in the session
- Concrete examples of changed behavior or architecture
- Verification that passed
- Verification that is still pending or inconclusive
- Environmental issues encountered during verification
- RCA conclusions that changed the team’s understanding
- Residual risk and recommended follow-up
- Difficulty assessment
- Effort or time-spent estimate when it can be supported honestly
- Retrospective notes on what went well, what was wasteful, and what should change next time

If the session included multiple pivots, mention them instead of smoothing them away.

## Evidence Rules

- Prefer concrete file paths, test names, and gate names over vague descriptions.
- Mention representative files, not a giant file dump, unless the user asks for a complete edit ledger.
- If you cite a verification result, say whether it was:
  - owner-local exact
  - broader integration
  - full gate
  - partial / interrupted / environment-affected
- If RCA showed that a suspected code failure was actually environment or session instability, say so clearly.
- If you estimate duration or effort, label whether it is exact from the session timeline or an evidence-backed estimate.

## Difficulty and Time

When the user wants `난이도`, `소요시간`, `공수`, or similar, add a dedicated section.

Cover:

- `Difficulty`
  - overall difficulty: low / medium / high / very high
  - why it was that hard: architecture depth, compile cost, RCA ambiguity, stale docs, cross-crate blast radius
- `Time / Effort`
  - actual elapsed time if the session record makes it clear
  - otherwise an evidence-backed estimate with wording like `roughly`, `at least`, or `session-observed`
- `Effort distribution`
  - exploration
  - patching
  - verification
  - RCA
  - docs / handoff

Use honest language:

- Good: `At least 2+ hours were spent in verification and RCA loops, based on repeated gate and cargo reruns in this session.`
- Good: `Difficulty was high because the work crossed kernel, parser, DFG, runtime, and gate layers while stale docs had to be treated as non-authoritative.`
- Bad: `Took 3.2 hours exactly` unless the session truly establishes that
- Bad: `Medium difficulty` with no basis

## Retrospective

When the user asks for `회고`, `retrospective`, `lessons`, `what we learned`, or similar, include a section with:

- `What went well`
- `What slowed us down`
- `What changed our understanding`
- `What we would do differently next time`

Good retrospective content usually includes:

- bad assumptions that got disproven
- docs-vs-code truth mismatches
- infra or environment friction
- whether verification setup was structurally weak
- whether the sequencing of patching vs verification worked

Do not turn retrospective into vague feelings. Anchor each point to actual session behavior.

## Operational Lessons

For leadership or CTO audiences, include operational lessons when relevant:

- tooling or infra changes that would shorten future work
- test/gate architecture changes that would make signoff cheaper
- documentation discipline issues
- opportunities to reduce fallback/compat debt earlier

These should be framed as concrete follow-ups, not generic advice.

## Output Styles

### A. CTO Report

Use this when the user says `CTO`, `exec`, `leadership`, `보고용`, or equivalent.

Tone:
- high signal
- strategic
- concrete
- honest about residual risk

Shape:
- short executive summary
- richer body paragraphs
- a clear residual and next-action section
- include `Difficulty and Effort` plus `Retrospective` when the user asks for a rich report

### B. Engineering Handoff

Use this when the user wants teammate continuity.

Add:
- exact remaining blockers
- verification commands or lanes
- recommended next operator moves

### C. Patch Ledger

Use this when the user wants "빠짐없이" or "세션에서 한 거 전부".

Add:
- lane-by-lane inventory
- notable files touched
- verification attempts
- failed attempts and reversals

## Compact Template

Use this shape when drafting:

```markdown
**Executive Summary**
One short paragraph on what changed in this session and the current signoff state.

**What We Changed**
Short paragraphs grouped by lane.

**Verification and RCA**
What passed, what was still running, what was disproven, and what remains uncertain.

**Residual Risk**
Concrete open items, blockers, or final signoff gaps.

**Next Actions**
Flat list of the next 2-5 highest leverage actions.
```

Extended template when the user wants richer reporting:

```markdown
**Executive Summary**
Short leadership-ready summary of the session outcome.

**What We Changed**
Grouped by lane, with representative files and decisions.

**Verification and RCA**
What passed, what failed, what was disproven, and what is still pending.

**Difficulty and Effort**
Overall difficulty, why it was difficult, rough time distribution, and effort hotspots.

**Retrospective**
What went well, what slowed us down, and what we should change next time.

**Residual Risk**
Concrete open items and signoff gaps.

**Next Actions**
Flat list of the next 2-5 highest leverage actions.
```

## Anti-Patterns

Do not:

- summarize only the final state and omit the actual work done
- turn partial verification into a clean bill of health
- erase failed hypotheses from the RCA
- blur code changes and documentation changes together
- present stale docs as the authority when the session established code truth first
- dump an unstructured changelog with no narrative
- over-index on repo-wide claims that were not established in the session
- invent exact time accounting that the session does not support
- write retrospective fluff with no connection to actual session events

## Example Requests

- `이 세션에서 한 작업 갈무리해서 CTO 보고용으로 푸부하게 정리`
- `이번 턴에서 한 거 빠짐없이 handoff용으로 정리`
- `지금까지 뭘 했는지 리더십 업데이트로 써줘`
- `세션 요약 말고 RCA 포함해서 리포트해줘`
- `난이도, 소요시간, 회고까지 넣어서 세션 보고서 써줘`

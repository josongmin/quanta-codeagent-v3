# RFC-02: Evidence Contract — Reconcile Model Claims Against the Tool Trace

**Status:** PROPOSED · **Priority:** P1 · **Axis:** 2 (증거 계약)

## Problem statement

The harness validates what the model **does** (tool calls: unknown tools denied, stale writes blocked, hallucinated merges rejected) but trusts what the model **says**. Nothing cross-checks prose assertions — "I verified X", "I read `src/foo.ts:123`", "tests pass" — against the actual tool trace. A final answer can cite files that were never read or don't exist, claim verification that never ran, and the harness will report it verbatim. The asymmetry: tool inputs are gated by ~9 layers (admissibility gate), tool *outputs into prose* are gated by zero.

This matters doubly here because the project's own history shows implementation agents self-reporting "wired+green" falsely 2/2 times until adversarially verified (jun-08 memory) — the same failure mode our users face.

## Evidence (3-round audit, reconciled)

What exists (don't rebuild):

- **Action-level enforcement (LIVE):**
  - Unknown tool → typed deny, loop continues: `src/agent/dispatch.ts:896-898`.
  - Hallucinated file path in read → typed `not_found`: `src/tool/read/index.ts:23-53`.
  - Hallucinated merge defense in edit (elision-copy, occurrence-count): `src/tool/edit/index.ts:142-200`.
  - Stale-read TOCTOU guard default-ON: `src/tool/stale-read-guard/gate.ts:37-42`.
- **verify-guard (LIVE, default-OFF, `QUANTA_VERIFY_GUARD` presence-based):** blocks finish when a mutating tool ran with no verify-classified call after it; must-pass tier blocks finish on failed verify. `src/agent/verify-guard.ts:142-194`, recognition registry (14 ecosystems) `src/agent/verify-signal.ts:53-96`, forcing via `tool_choice:"any"` `src/agent/tool-choice.ts:93-156`. **This covers act-without-verify, not say-without-act.**
- **Memory placement provenance (ADR-0082):** deterministic record of which memories were placed where — context provenance, NOT assertion provenance.
- **ToolResult.evidence (LIVE, optional):** `src/tool/types.ts:1005-1011` — tools MAY report cited paths, but nothing mandates it and there is **no link back to the originating tool_use id** (`ctx.toolCallId` exists separately at `types.ts:312`).
- **progress-audit system skill (ADR-0045):** "no finding without code evidence" — prompt-discipline only, applies when the skill is invoked.

What does NOT exist (confirmed across rounds; R2's attempted refutation via verify-guard was scope-confused — verify-guard checks *edits*, not *claims*):

- No validation that file paths mentioned in final assistant prose exist (R3 finding 2A; `AgentOutcome` `src/agent/types/agent-outcome.ts:77-128` carries the transcript, nothing validates it).
- No reconciliation of "I tested/verified/confirmed" prose against verify-signal history.
- No structured citation ("source-tag") on model assertions — zero matches for any such feature in `src/` (the jun-04 "source-tag" memory referred to something else; confirmed absent).
- **Doc/code drift found en route:** CLI knob docs say verify-guard max-trips default 2; code says `DEFAULT_MAX_TRIPS = 1` (`src/agent/verify-guard.ts:102`, `src/apps/cli/cli-knobs.ts:406-411`).

## Goals

1. At turn finish, deterministically cross-check the final assistant text against the session's tool trace and surface mismatches (path claims, verification claims).
2. Make tool-reported evidence traceable to the call that produced it.
3. Fix the verify-guard doc/code drift.

## Non-goals

- NLP-grade claim extraction or LLM-judged truthfulness of arbitrary prose — only deterministic, pattern-anchored checks (paths, verification verbs + test claims), consistent with the no-heuristics rule.
- Forcing citations into every answer (prompt-bloat; competitor parity doesn't require it).
- Blocking finish by default — first ship as **annotate/warn**, escalation to forcing is a later, gated decision.

## Workstreams (ticket-able)

### W1 — Closeout claim-trace check: path claims (deterministic)
At the finish chokepoint (same seam as verify-guard / closeout in `src/agent/loop/turn-outcome.ts`), scan the final assistant text for path-shaped references (existing path-recognition utilities; repo-relative + absolute). For each: (a) does the path exist on disk, and (b) was it touched by any tool call this session (read/edit/grep hit)? Mismatches produce a structured `claimAudit` annotation: `{path, exists, observedInTrace}`.

Posture: **annotate-only**, attached to the outcome (consumed by RFC-07's summary and `/state`); a separate `QUANTA_CLAIM_TRACE_FORCE` (default-OFF) can convert "path does not exist" into a verify-guard-style forcing message.

**Acceptance:** unit tests: nonexistent claimed path → flagged; path read this session → clean; prose without paths → zero-cost no-op. Hellgate: model fabricates a path in final text under replay → annotation present. **Default:** check ON (annotation is additive and cheap — stat per unique mentioned path), forcing OFF.

### W2 — Closeout claim-trace check: verification claims (deterministic)
Reuse `verify-signal.ts` matchers in reverse: if the final text asserts verification (anchored patterns: "tests pass(ed)", "verified", "확인했", "all green" — small fixed registry, mirroring the 14-ecosystem matcher style) but the session trace contains **no verify-classified tool call**, or the last verify-classified call **failed** (failure-outcome matchers `verify-signal.ts:152-188`), flag `{claim: "verified", trace: "none" | "last-verify-failed"}`.

This is the harness-level mirror of the false "wired+green" self-report problem.

**Acceptance:** unit: claim+no-verify → flagged; claim+passing-verify → clean; no claim → no-op. Must not fire on quoted/negated text ("tests do NOT pass") — pattern set is small and anchored precisely to keep false positives at zero (false-positive-zero posture, like the staleness gate). **Default:** ON (annotate-only).

### W3 — ToolResult.evidence ⇄ tool-call cross-link
Add `toolCallId` to `ToolResultEvidence` (populated from `ctx.toolCallId`, already threaded at `src/tool/types.ts:312`), so downstream consumers (W1, RFC-07, web surfaces) can trace any evidence item to the exact call. Optional-field addition; byte-identical when absent.

**Acceptance:** populating tools (read/edit/grep first) carry the id; type-level test that absence stays legal. **Default:** ON for the tools we touch.

### W4 — verify-guard max-trips doc/code reconciliation (tiny)
Decide intended default (1 or 2), align `src/agent/verify-guard.ts:102` and `src/apps/cli/cli-knobs.ts:406-411` + `--help` text, add a knob-registry test pinning the documented default to the code constant (drift-guard pattern).

**Acceptance:** single source of truth asserted by test. **Default:** unchanged gate posture (OFF).

### W5 — (Stretch) surface the annotations
Render `claimAudit` in CLI turn summary (`src/apps/cli/turn-summary.ts` collector already exists) and include in the agent-state push for web. Depends on W1/W2 shapes; coordinate with RFC-07.

## Risks

- False positives erode trust fastest. Mitigation: anchored pattern sets, annotate-only default, zero-FP acceptance bar (same bar the staleness gate met before going default-ON).
- Path-scan cost on huge answers: bounded by unique path mentions; stat-only, no reads.

## Relations

- Builds on: verify-guard/verify-signal, ToolResult.evidence, turn-outcome finish seam.
- Feeds: RFC-07 pre-handoff summary (failureCause can cite claim-audit), `/state`.
- ADR required (L3 feature, DoD three-axis bar applies).

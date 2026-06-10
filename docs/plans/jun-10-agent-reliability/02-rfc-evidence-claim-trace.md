# RFC-02 (FINAL): Evidence Contract — Reconcile Model Claims Against the Tool Trace

**Status:** FINAL · **Priority:** P1 · **Axis:** 2 (증거 계약)
**R4 revision:** seams corrected (annotate at `finishAgentSession`, force via `guards/chain.ts`); prose-path extractor is an explicit deliverable (no existing utility); toolCallId threading is conditional today; Korean-negation fixtures added to the FP-zero bar; hallucinated-API coverage explicitly dispositioned.

## Problem statement

The harness validates what the model **does** (unknown tools denied, stale writes blocked, hallucinated merges rejected) but trusts what the model **says**. Nothing cross-checks prose assertions — "I verified X", "I read `src/foo.ts:123`", "tests pass" — against the actual tool trace. The asymmetry: tool inputs pass ~9 gate layers; prose passes zero. The project's own history shows why this matters: implementation agents self-reported "wired+green" falsely 2/2 times until adversarially verified (jun-08) — the same failure mode users face.

## Evidence (3-round audit + R4 seam verification)

What exists (don't rebuild):

- **Action-level enforcement (LIVE):** unknown tool typed deny `src/agent/dispatch.ts:896-898`; read `not_found` `src/tool/read/index.ts:23-53`; edit merge defenses `src/tool/edit/index.ts:142-200`; stale-read-guard default-ON `src/tool/stale-read-guard/gate.ts:37-42`.
- **verify-guard (LIVE, default-OFF, presence gate `QUANTA_VERIFY_GUARD`):** blocks finish on mutate-without-verify; must-pass tier on failed verify. `src/agent/verify-guard.ts:142-194`; 14-ecosystem recognition `src/agent/verify-signal.ts:53-96`, failure matchers `:152-188`. Covers act-without-verify, **not** say-without-act.
- **R4 seam facts:** verify-guard/closeout run via `runGuardChain` in `src/agent/loop/recovery-executor.ts:203` (`src/agent/guards/chain.ts`) — NOT in turn-outcome; the final assistant text + `wm` are in scope at `finishAgentSession` (`src/agent/loop/session-lifecycle.ts:123`). No existing free-prose path-extraction utility exists (mention-runner parses `@`-mentions only) — the extractor must be built.
- **ToolResult.evidence (LIVE, optional):** `src/tool/types.ts:1005-1011`; `ctx.toolCallId` is threaded **conditionally** — only when the ADR-0440 `onToolDiff` sink is wired (`src/agent/dispatch.ts:803`); the `types.ts:312` comment says so.
- **Doc/code drift:** verify-guard max-trips — code `DEFAULT_MAX_TRIPS = 1` (`src/agent/verify-guard.ts:102`); knob docs say 2 (`src/apps/cli/cli-knobs.ts:584-599`; `internal.ts:386` comment also says 2). Drift confirmed on both sides.
- Absent (confirmed): prose-path validation, verification-claim reconciliation, structured assertion citations ("source-tag" does not exist in src/).

## SOTA alignment (R4 corpus)

- **Citation formats are prompt-only across the industry.** Cursor mandates `` `startLine:endLine:filepath` `` fenced citations (`cursor-agent-exec/dist/main.js:~213378`); Claude Code prompts `file_path:line_number`. **No competitor validates cited paths/lines at runtime.** W1 is exceed-class.
- **Claim-vs-trace:** Claude Code's hook model (Stop hook with `last_assistant_message`; PostToolUse can replace output / block continuation) is the strongest *seam* a competitor exposes — but it's user-configured infrastructure, no shipped default check. W2 ships the check itself — exceed-class.
- **Read-before-edit / stale detection:** Claude Code enforces at the tool layer (content-hash, "File content has changed") — quanta's stale-guard is at parity (mtime vs hash noted as a possible hardening, out of scope here).
- Absorb move folded in: Claude Code's Stop-hook shape (inspect last assistant message at turn end) validates our choice of finish-seam annotation over mid-stream checking.

## Goals

1. At turn finish, deterministically cross-check the final assistant text against the session's tool trace; surface mismatches (path claims, verification claims) as structured annotations.
2. Make tool-reported evidence traceable to the producing call.
3. Fix the verify-guard doc/code drift.

## Non-goals

- NLP-grade claim extraction or LLM-judged truthfulness — deterministic, pattern-anchored checks only (no-heuristics rule).
- **Hallucinated API/symbol claims ("`fooBar()` handles this") — deliberately deferred** (R4-M10 disposition): symbol-existence checking requires the import-graph/LSP machinery RFC-03 W1 builds; revisit as a gated stretch after RFC-03 lands. Recorded here so the axis-2 fragment isn't silently dropped.
- Forcing citations into every answer; blocking finish by default (annotate first, forcing is gated).

## Workstreams (ticket-able; see tickets/T-201..205)

### W1 — Prose path-claim audit (extractor + builder + finish-seam annotation)
**Deliverable 1 — extractor (new, specced):** deterministic free-prose path extractor (repo-relative + absolute forms, fenced/inline code spans included; anchored patterns, no fuzzy matching). FP-zero acceptance bar with adversarial fixtures: URLs, version strings, `a/b` diff prefixes, prose slashes.
**Deliverable 2 — audit builder:** for each extracted path: `{path, exists (stat), observedInTrace (read/edit/grep-hit this session)}`.
**Deliverable 3 — wiring:** attach as `claimAudit` at `finishAgentSession` (`session-lifecycle.ts:123`) — same seam as RFC-07 W1, shapes coordinated.

**Acceptance:** nonexistent claimed path → flagged; session-read path → clean; pathless prose → zero-cost no-op; extractor adversarial fixture suite green. **Default:** ON (annotate-only; registered in 00-index posture table).

### W2 — Verification-claim audit (deterministic)
If final text asserts verification (small anchored registry: "tests pass(ed)", "verified", "all green", "확인했…" — **Korean fixtures must cover conjugation/negation: "확인했지만 실패", "확인 못 했", "테스트는 통과 못함"**) and the trace has no verify-classified call, or the last one **failed** (matchers `verify-signal.ts:152-188`), flag `{claim, trace: "none" | "last-verify-failed"}`. Quoted/negated text must not fire — FP-zero bar, both languages.

**Acceptance:** claim+no-verify flagged; claim+passing clean; negation fixtures (en+ko) clean; no claim → no-op. **Default:** ON (annotate-only).

### W3 — Force-guard variant (gated)
A third guard in `guards/chain.ts` (alongside verify-guard) converting W1 "claimed path does not exist" / W2 "claim without verify" into a forcing message, budgeted like verify-guard trips. Gate `QUANTA_CLAIM_TRACE_FORCE`, **default-OFF**.

**Acceptance:** guard-chain integration test; trip budget respected; OFF → byte-identical.

### W4 — toolCallId unconditional threading + evidence cross-link
Thread `toolCallId` into tool ctx **unconditionally** (today conditional on `onToolDiff`, `dispatch.ts:803` — contract change, needs byte-identical check on existing outputs), then add `toolCallId` to `ToolResultEvidence`; populate in read/edit/grep.

**Acceptance:** threading present without onToolDiff wired; evidence carries id in the three tools; absence stays legal for others.

### W5 — verify-guard max-trips doc/code reconciliation (tiny)
Decide 1 vs 2; align `verify-guard.ts:102`, `cli-knobs.ts:584-599`, `internal.ts:386` comment, `--help`; add a knob-registry test pinning doc default == code constant (drift-guard pattern).

## Risks

- False positives erode trust fastest → anchored patterns, annotate-only defaults, FP-zero acceptance incl. Korean negation (R4-L5).
- Path-scan cost bounded: stat per unique mentioned path, no reads.
- W4's unconditional threading touches the dispatch hot path — byte-identical regression check mandatory.

## Relations

- Feeds RFC-07 (claimAudit → failureCause enrichment) and `/state`.
- Surfacing rides RFC-07 W4's CLI panel (no separate surface ticket here).
- ADR required (L3, full DoD bar).

# RFC-01: Tool-Routing Quality — Measurement First, Then Runtime Escalation

**Status:** PROPOSED · **Priority:** P2 (deliberately measurement-gated) · **Axis:** 1 (도구 선택 품질)

## Problem statement

The agent's tool-selection quality — "don't spin up LSP when grep suffices; don't flail with grep when LSP is needed" — is enforced **only by prompt text**. There is no runtime mechanism that detects a wrong rung on the cheap→AST→LSP ladder, no degrade path that names the cheaper alternative when LSP is unavailable, and — most importantly — **no measurement** of whether the model actually follows the ladder, even though per-call duration telemetry is already collected and then ignored.

We cannot fix what we don't measure, and the house rule forbids inventing thresholds ("grep > 50 matches → escalate") without data. So this RFC is structured as: **measure (W1, W2) → deterministic no-threshold fixes (W3, W4) → data-gated interventions (W5)**.

## Evidence (3-round audit, reconciled)

What exists (all verified LIVE):

- **Prompt ladder (default-ON, advisory only):** `src/agent/prompt-body.ts:214-252` — "the truth condition picks the tool, not the keyword", 3-stage fault-localization ladder (search/localize/grep → read + lsp_document_symbol → lsp_references/grep), "pick the cheapest tool whose output is sufficient evidence". Canonical analysis ladder `file_tree_summary → glob → ls → read` at `prompt-body.ts:194`.
- **Exploration ladder as runtime constant:** `src/agent/exploration-ladder.ts` — feeds the skill-scoping gate (`READ_ONLY_EXPLORATION` nav base), i.e. the ladder vocabulary exists in code, but only for *availability*, not *routing*.
- **LSP registry gate:** LSP nav tools (8 read-only + rename) appear only when `QUANTA_LSP_TOOLS=full` (`src/agent/lsp-bridge.ts:220-234`, `src/apps/cli/internal.ts`). This is an availability gate, not a cost-aware router.
- **Admissibility gate is post-dispatch safety only:** `src/agent/admissibility-gate.ts` — allow/deny/ask on the model's chosen tool; silent on cost/efficiency.
- **ToolChoice forcing is narrow:** `src/agent/tool-choice.ts:93-156` — only `verifyGuardViolated` / `closeoutAttempted` / explicit host override. No routing signals.
- **Telemetry collected but unconsumed:** `src/observability/metrics/instrument-tool.ts:38-70` wraps every tool with `tool.call.duration_ms` histograms; `src/observability/attrs.ts:196` records per-span duration. **No consumer reads this for routing quality.**
- **LSP unavailability:** clean typed failure with `unavailableReason` (`src/agent/lsp-bridge.ts:143-164`) — but the failure message does not name the cheaper fallback the model should use instead.
- **Search pipeline (`src/retrieval/`, 31 files):** budget-aware internally, but static — no escalation between lexical/semantic stages triggered by result quality.

What does NOT exist (confirmed by R1+R2, false leads eliminated):

- No pre-dispatch cost-aware routing, no counter-proposal mechanism.
- No escalation reaction to search-result volume/ambiguity.
- No routing-quality metric anywhere (smoke, eval, OTel dashboards).
- `read-routing` in `src/config/knob-inventory.ts:12` is a **knob-framework** concept (routing knob *reads* to a registry, P4) — unrelated; recorded so nobody mistakes it for this feature again.

## Goals

1. Make tool-routing quality **observable** (offline metric over existing spans + smoke replays).
2. Close the two deterministic, no-threshold gaps that need no data to justify: unavailability degrade hints and truncation-time ladder hints.
3. Only after measurement: decide whether runtime escalation/routing enforcement is worth building, and with what (validated) trigger conditions.

## Non-goals

- Pre-dispatch tool rewriting ("model said LSP, run grep instead") — violates the model-autonomy design and risks correctness; not proposed at any phase.
- Any match-count / latency threshold chosen without W1 data (house rule: no arbitrary heuristics; n=1 doesn't change the loop).
- Changing the `QUANTA_LSP_TOOLS` default.

## Workstreams (ticket-able)

### W1 — Routing-quality metric (offline, descriptive)
Build an analyzer over session transcripts / OTel spans that computes per-session descriptive stats — no judgments baked in:
- grep/search retry chains (same tool, tweaked args, N consecutive — prompt-body already defines "doesn't count as a switch", reuse that definition);
- LSP calls with zero prior cheap-rung attempts in the same fault-localization episode;
- ladder-order violations (read-before-locate, references-before-symbol);
- per-tool duration distributions (consume `tool.call.duration_ms`, today write-only).

**Deliverable:** `tools/` analyzer + report command (CI-adjacent, not runtime). **Acceptance:** runs over `tests/smoke/` replay fixtures and over a recorded live session; emits a stable JSON report. **Default:** N/A (offline tool).

### W2 — Routing smoke scenarios
Add smoke fixtures (replay, LLM-judge where needed — `tests/smoke/` battery already supports this) that pin routing behavior: "known identifier in known file → grep/read path, not LSP", "rename-impact question → references path". These become the regression net for any later intervention.

**Acceptance:** ≥4 scenarios, green under `bun run smoke`; judged rubric for tool-sequence sanity. **Default:** test-side only.

### W3 — Unavailability degrade hints (deterministic, no thresholds)
When an LSP tool fails with `unavailableReason` (server not installed/not on PATH), append a deterministic next-step to the typed failure: which cheap rung answers the same question (`lsp_references` → `grep` of the symbol; `lsp_definition` → `grep` for declaration patterns). Pure string mapping per tool, no state.

**Evidence anchor:** `src/agent/lsp-bridge.ts:143-164`. **Acceptance:** unit tests per nav tool asserting the hint text; byte-identical when the server IS available. **Default:** ON (it's failure-message content, not behavior).

### W4 — Truncation-time ladder hints (deterministic)
Grep/search outputs already have truncation boundaries. When output is truncated, the truncation notice names the ladder's next rung ("result truncated — narrow with path filters, or use lsp_document_symbol / search_codebase for structural queries"). Trigger = the existing truncation event, not a new threshold.

**Acceptance:** unit test: truncated output carries the hint; non-truncated output byte-identical. **Default:** ON (failure/truncation-notice content only).

### W5 — (Gated on W1 data) runtime escalation signal
Only if W1 shows a material miss rate: extend `ToolChoiceSignals` with a routing nudge (e.g. system-reminder injection after N-validated retry chains, where N comes from measured distributions). Ships default-OFF behind a `QUANTA_*` gate, with W2 scenarios as the regression net.

**Acceptance (precondition):** W1 report demonstrating the failure mode at meaningful frequency, cited in the ticket. Without that, this workstream stays unopened.

## Risks

- Over-nudging degrades model autonomy and can loop (hint → model retries → hint). Mitigation: W3/W4 are static message content; W5 is data-gated and default-OFF.
- Metric definition skew (W1 "episode" segmentation). Mitigation: descriptive-only reporting first; no enforcement consumes W1 directly.

## Relations

- Competitor baseline: Claude Code is also prompt-guidance-only for this; we are at parity today. W3/W4 are cheap SOTA+ moves; W5 would exceed baseline only if data justifies.
- Touches: `src/agent/lsp-bridge.ts`, grep/search tool output paths, `src/agent/tool-choice.ts` (W5 only), `tools/` (W1), `tests/smoke/` (W2).

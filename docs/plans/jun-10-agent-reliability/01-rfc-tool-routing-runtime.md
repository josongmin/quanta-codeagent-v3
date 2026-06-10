# RFC-01 (FINAL): Tool-Routing Quality — Measurement First, Then Runtime Escalation

**Status:** FINAL · **Priority:** P2 (deliberately measurement-gated) · **Axis:** 1 (도구 선택 품질)
**R4 revision:** SOTA alignment added (Cursor leads this axis — absorb list updated); W1 split into spec vs analyzer (the episode/metric definitions are the hard part).

## Problem statement

Tool-selection quality — "don't spin up LSP when grep suffices; don't flail with grep when LSP/semantic search is needed" — is enforced **only by prompt text**. No runtime mechanism detects a wrong rung on the cheap→AST→LSP ladder, no degrade path names the cheaper alternative when LSP is unavailable, and **no measurement** of ladder compliance exists even though per-call duration telemetry is collected and then ignored.

We cannot fix what we don't measure, and the house rule forbids inventing thresholds without data. Structure: **measure (W1a/W1b/W2) → deterministic no-threshold fixes (W3/W4) → data-gated interventions (W5)**.

## Evidence (3-round audit, reconciled; false leads eliminated)

What exists (verified LIVE):

- **Prompt ladder (default-ON, advisory):** `src/agent/prompt-body.ts:214-252` — "the truth condition picks the tool", 3-stage fault-localization ladder, "pick the cheapest tool whose output is sufficient evidence"; analysis ladder `file_tree_summary → glob → ls → read` at `:194`.
- **Exploration ladder as runtime constant:** `src/agent/exploration-ladder.ts` — feeds the skill gate's nav base (availability, not routing).
- **LSP registry gate:** nav tools only under `QUANTA_LSP_TOOLS=full` (`src/agent/lsp-bridge.ts:220-234`, `src/apps/cli/internal.ts`) — availability gate, not cost router.
- **Admissibility gate is post-dispatch safety only** (`src/agent/admissibility-gate.ts`); **ToolChoice forcing is narrow** (`src/agent/tool-choice.ts:93-156` — verify/closeout/explicit only).
- **Telemetry collected, unconsumed:** `tool.call.duration_ms` histograms wrap every tool (`src/observability/metrics/instrument-tool.ts:38-70`; `src/observability/attrs.ts:196`). Zero routing-quality consumers.
- **LSP unavailability:** typed failure with `unavailableReason` (`src/agent/lsp-bridge.ts:143-164`); the message does not name the cheaper fallback. Mention-resolver has an lsp/semantic fallback chain (`src/agent/mention-runner/default-resolver.ts:113-125`) — mentions only, not tools.
- **Search pipeline** (`src/retrieval/`, 31 files): budget-aware internally, static — no quality-triggered escalation.

Absent (confirmed): pre-dispatch cost routing, result-volume escalation, routing metrics. False lead recorded: `read-routing` = knob-framework term (P4, `src/config/knob-inventory.ts:12`), not tool routing.

## SOTA alignment (R4 corpus — Cursor leads this axis)

- **Cursor (strongest baseline):**
  - *Prompt:* "Semantic search is your MAIN exploration tool… `grep` is for *follow-up*, not discovery; do not translate a conceptual question into a regex of related words" (`cursor-agent-exec/dist/main.js`). Sharper than quanta's ladder text — **absorb into W4's prompt-side refresh**.
  - *Runtime:* cheap/expensive model config with cost threshold gating (`cheap_model_name`, `threshold_for_expensive_run_modal_cents`), `use_whitespace_insensitive_fallback` with hit tracking, `isDegradedMode` flags + fallback-warning counters (`cursor-retrieval`, `cursor-always-local`). So runtime cost-aware degrade **does exist in the industry** — validating W3 as absorb-class, not speculative.
  - *Telemetry:* TOOL_FORMER / ONLINE_METRICS instrumentation of tool formation — precedent for W1.
- **Claude Code:** prompt-guidance only on this axis (+ hook seams). **Codex:** nothing verified.
- **Exceed criteria:** measured ladder-compliance metric over real sessions (nobody evals routing quality offline), and deterministic in-band degrade hints tied to typed failures (Cursor's degrade is UI-level, not agent-prompt-level).

## Goals

1. Make routing quality observable (offline metric + smoke replays).
2. Close the deterministic no-threshold gaps: unavailability degrade hints, truncation-time ladder hints, and a Cursor-grade routing prompt refresh.
3. Only with W1 data: decide whether runtime escalation is worth building, with validated triggers.

## Non-goals

- Pre-dispatch tool rewriting (model autonomy stays).
- Any threshold not derived from W1 measurement (no-heuristics rule).
- Changing the `QUANTA_LSP_TOOLS` default.

## Workstreams (ticket-able; see tickets/T-101..104; W5 conditional, no ticket until gated)

### W1a — Routing-quality metric SPEC + fixtures (the hard part, split per R4-L4)
Define, with worked examples over real transcripts: "fault-localization episode" segmentation; retry-chain definition (reuse prompt-body's "tweaked argument ≠ switch"); ladder-order violation taxonomy; the descriptive stats reported (chain lengths, zero-cheap-rung LSP calls, per-tool duration distributions). Deliverable: spec doc + annotated fixture transcripts (golden inputs/outputs for W1b).

### W1b — Analyzer implementation
`tools/` analyzer + report command consuming session transcripts / OTel spans (`tool.call.duration_ms` finally gets a consumer) per W1a spec. Runs over `tests/smoke/` replay fixtures and recorded live sessions; stable JSON report. Offline/CI-adjacent, not runtime.

### W2 — Routing smoke scenarios
≥4 smoke fixtures (replay + LLM-judge rubric for tool-sequence sanity) pinning routing behavior: known-identifier → grep/read not LSP; rename-impact → references path; conceptual question → search_codebase first. Regression net for any later intervention.

### W3 — Unavailability degrade hints (deterministic; absorb-class per Cursor's degraded-mode precedent)
LSP tool fails `unavailableReason` → append a deterministic next-step naming the cheap rung that answers the same question (`lsp_references`→grep symbol; `lsp_definition`→grep declaration patterns). Pure per-tool string map; byte-identical when the server is available. **Default ON** (failure-message content only; posture table in 00-index).

### W4 — Truncation-time ladder hints + routing-prompt refresh (deterministic)
(a) Grep/search truncation notices name the next rung ("narrow with path filters, or use lsp_document_symbol / search_codebase for structural queries") — trigger = existing truncation boundary, no new threshold. (b) Absorb Cursor's sharper routing language into `prompt-body.ts` ("grep is for follow-up, not discovery; don't translate a conceptual question into a regex of synonyms") — prompt-byte change, pinned by W2 scenarios. **Default ON** (message/prompt content).

### W5 — (Gated on W1 data) runtime escalation signal — NO TICKET YET
Only if W1b shows a material miss rate: extend `ToolChoiceSignals` with a routing nudge whose trigger comes from measured distributions. Default-OFF gate; W2 as regression net. Ticket opens only with the W1b report attached.

## Risks

- Over-nudging loops (hint → retry → hint): W3/W4 are static content; W5 is data-gated, default-OFF.
- Metric skew: W1a fixtures are the contract; analyzer is descriptive-only, nothing enforces from it directly.

## Relations

- Touches `lsp-bridge.ts`, grep/search output paths, `prompt-body.ts` (W4b), `tool-choice.ts` (W5 only), `tools/` (W1), `tests/smoke/` (W2).
- Competitor posture: parity with Claude Code today; W3/W4 reach Cursor-grade; W1+W5 exceed.

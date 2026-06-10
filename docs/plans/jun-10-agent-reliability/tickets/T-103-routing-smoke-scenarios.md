# T-103: Routing smoke scenarios

**RFC:** [01·W2](../01-rfc-tool-routing-runtime.md) · **Priority:** P2 · **Size:** M · **Deps:** none · **Posture:** test-side

## Deliverable
≥4 smoke fixtures in `tests/smoke/` (replay + LLM-judge rubric for tool-sequence sanity) pinning routing behavior: known identifier in known file → grep/read path, not LSP; rename-impact question → references path; conceptual "where do we X" → search_codebase first (Cursor's "grep is for follow-up" posture); truncated-grep recovery. These are the regression net for T-105's prompt refresh and any future W5 intervention.

## Acceptance criteria
- [ ] ≥4 scenarios green under `bun run smoke` (replay).
- [ ] Judge rubric scores tool-sequence sanity (judge.ts pattern, fail-closed).

# T-104: LSP unavailability degrade hints

**RFC:** [01·W3](../01-rfc-tool-routing-runtime.md) · **Priority:** P2 · **Size:** S · **Deps:** none · **Posture:** ON (failure-message content only)

## Deliverable
When an LSP nav tool fails with `unavailableReason` (`src/agent/lsp-bridge.ts:143-164`), append a deterministic next-step naming the cheap rung answering the same question: `lsp_references` → grep the symbol; `lsp_definition` → grep declaration patterns; etc. Pure per-tool string map, no state, no thresholds. Absorb-class (Cursor ships `isDegradedMode` + fallback warnings at UI level; we put the hint in-band where the agent acts on it).

## Acceptance criteria
- [ ] Unit per nav tool asserting hint text on unavailable.
- [ ] Server available → byte-identical output.

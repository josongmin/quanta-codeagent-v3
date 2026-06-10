# T-105: Truncation ladder hints + routing-prompt refresh

**RFC:** [01·W4](../01-rfc-tool-routing-runtime.md) · **Priority:** P2 · **Size:** S · **Deps:** T-103 (regression net first) · **Posture:** ON (message/prompt content)

## Deliverable
1. Grep/search truncation notices name the ladder's next rung ("narrow with path filters, or use lsp_document_symbol / search_codebase for structural queries") — trigger = the existing truncation boundary, no new threshold.
2. Absorb Cursor's sharper routing language into `src/agent/prompt-body.ts` ("grep is for follow-up, not discovery; do not translate a conceptual question into a regex of synonyms" — corpus `cursor-agent-exec`). Prompt-byte change pinned by T-103 scenarios.

## Acceptance criteria
- [ ] Truncated output carries the hint; non-truncated byte-identical.
- [ ] Prompt change lands with T-103 smoke green (routing behavior not regressed).
- [ ] Prompt-bytes pinned by existing prompt tests.

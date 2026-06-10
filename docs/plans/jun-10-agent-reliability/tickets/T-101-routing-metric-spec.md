# T-101: Routing-quality metric SPEC + annotated fixtures

**RFC:** [01·W1a](../01-rfc-tool-routing-runtime.md) · **Priority:** P2 · **Size:** M · **Deps:** none · **Posture:** offline

## Deliverable
The definitions are the hard part (split per R4-L4). Spec doc defining, with worked examples over real transcripts: "fault-localization episode" segmentation; retry-chain definition (reuse prompt-body's "tweaked argument ≠ switch", `src/agent/prompt-body.ts:194`); ladder-order violation taxonomy; reported descriptive stats (chain lengths, zero-cheap-rung LSP calls, per-tool duration distributions). Deliverable includes annotated fixture transcripts = golden inputs/outputs for T-102. No enforcement semantics — descriptive only (no-heuristics rule).

## Acceptance criteria
- [ ] Spec reviewed against ≥2 real recorded sessions (definitions produce unambiguous segmentation).
- [ ] Golden fixtures checked in with expected metric outputs.

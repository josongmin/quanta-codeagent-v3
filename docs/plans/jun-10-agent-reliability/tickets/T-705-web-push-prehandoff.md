# T-705: Web push of PreHandoffSummary — BLOCKED

**RFC:** [07·W5](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P1 · **Size:** M · **Deps:** T-701 + **jun-9 parity Tier B agent-state push channel (not yet landed)** · **Posture:** ON when channel lands

## Deliverable
Include `PreHandoffSummary` in the agent-state push extension once that channel lands (per docs/plans/jun-9-cli-web-parity: state rides the existing push extension, not a new transport). The web-bridge 6-event SSOT pin (`toSessionHostTurnEvent`) must be **deliberately** extended, not drifted.

## Acceptance criteria
- [ ] Bridge event decode test for the new payload.
- [ ] 6-event SSOT pin updated in the same PR with explicit reviewer callout.
- [ ] Web card renders the three sections; absent summary → no card.

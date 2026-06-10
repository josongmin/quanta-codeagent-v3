# T-703: hand-off-required deniedAction capture

**RFC:** [07·W3](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P0 · **Size:** S · **Deps:** T-701 · **Posture:** ON (additive)

## Deliverable
When the admissibility gate hard-denies with hand-off-required, capture the categorical decision (the decision emitter already fires — plumb the last deny into session resources) so `buildPreHandoffSummary` populates `failureCause.deniedAction: {tool, layer}`. Model-facing `HANDOFF_SUFFIX` (`src/agent/dispatch-helpers.ts:22`) stays byte-identical.

## Acceptance criteria
- [ ] Integration: hand-off deny → outcome carries deniedAction (categorical only).
- [ ] 32-cell matrix e2e (`tests/integration/hand-off-required-universal-e2e.test.ts`) unchanged.
- [ ] safeReason discipline: no command/user input echoed.

# T-704: CLI checkpoint panel + /state last-summary

**RFC:** [07·W4](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P0 · **Size:** M · **Deps:** T-701 · **Posture:** ON (render of additive data)

## Deliverable
1. CLI checkpoint panel rendered on non-completed stops (reuse turn-summary/away-summary render style, `src/apps/cli/turn-summary.ts`): partialProgress (files/verify/last activity), failureCause, nextActions.
2. `/state` (`src/apps/cli/slash/registry-surface.ts:387-411`) shows the last PreHandoffSummary for a stopped session.
3. Render failures degrade to reason-code-only (today's floor) — never block teardown.

## Acceptance criteria
- [ ] CLI snapshot tests per stop class.
- [ ] /state panel test with a stopped-session fixture.
- [ ] Render-failure degradation test.
- [ ] Also renders RFC-02 claimAudit annotations when present (coordinated shape).

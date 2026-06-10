# T-701: PreHandoffSummary type + deterministic builder + nextActions registry

**RFC:** [07·W1](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P0 (north-star) · **Size:** L · **Deps:** none · **Posture:** ON (additive outcome field)

## Deliverable
1. `PreHandoffSummary` type per the RFC's design block (partialProgress / failureCause / nextActions).
2. Pure no-throw `buildPreHandoffSummary(wm, stopInfo, opts)`: **filesChanged derived from edit-class tool successes in the trace** (turn-diff ledger only enriches — it's opt-in, ADR-0125); verifyState from verify-signal matchers; exhaustion from the budget proposition; category from StopCategory.
3. nextActions template registry (closed, cause-keyed; Claude-Code-style actionable wording; unknown cause → empty array, never filler).
4. Attach in `finishAgentSession` (`src/agent/loop/session-lifecycle.ts:123`) for every `reason !== "completed"` + completed-with-failed-verify.
5. Sanitization: categorical-only (same contract as `emitGateDecision`, `src/agent/admissibility-gate.ts:284-287`) — denied command text must never appear.

## Evidence anchors
`src/agent/types/agent-outcome.ts:77-128` (no summary fields today), `src/agent/budget/meter.ts:214-248`, `src/agent/stop-category.ts:133-193`, `src/agent/verify-signal.ts:53-96`.

## Acceptance criteria
- [ ] Unit per stop class (budget / error / hand-off / abort / refusal) asserting full population.
- [ ] Property test: never throws on arbitrary truncated traces.
- [ ] Sanitization test: denied bash command text absent from summary.
- [ ] filesChanged populated with ledger unwired (trace-derived).
- [ ] Hosts ignoring the field byte-compatible. ADR filed (L3 DoD bar).

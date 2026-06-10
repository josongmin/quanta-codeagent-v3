# T-702: BudgetExhaustionPolicy dispatch at finish (truth-telling enum)

**RFC:** [07·W2](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P0 · **Size:** M · **Deps:** T-701 · **Posture:** per-policy semantics

## Deliverable
Read `meter.exhaustion` (public readonly, `src/agent/budget/meter.ts:51,74` — stored today with **zero readers**) at the finish site (`src/agent/loop/turn-outcome.ts:61-73`):
- `"stop"` → today + summary.
- `"stop-with-summary"` → summary + surface checkpoint render (T-704 renderer).
- `"emit-partial"` → **turn-boundary semantic (R4-H4 redefinition):** guarantee in-flight turn artifacts in `outcome.messages` (already true at this seam) + set `failureCause.truncated: true`. (NOT mid-stream text flushing — text is complete at turn boundary and the crash-resume accumulator is across the slice fence.)
- `"ask-user"` / `"fail-run"` → implement per documented semantics **or delete from the enum** — either way the type stops lying.
- Echo effective policy in `failureCause.exhaustion.policy`.

## Acceptance criteria
- [ ] Integration test per policy value.
- [ ] Hellgate: `emit-partial` outcome carries truncated marker + complete in-flight messages.
- [ ] Structural test: enum has zero never-read members.
- [ ] Default `"stop"` behavior unchanged except the additive summary.

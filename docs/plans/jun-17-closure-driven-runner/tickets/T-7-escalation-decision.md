# T-7: explicit multi-owner escalation

**Priority:** P1 · **Size:** M · **Deps:** [T-4](T-4-gate-decision-wiring.md), [T-5](T-5-owner-admission-linkage.md), [T-6](T-6-patch-hygiene-linkage.md) · **Posture:** OFF (`repair-escalation`)

## Deliverable

Escalate only on explicit multi-owner evidence. Never widen on vibe.

Inputs:

- corroborated strong owner candidates
- `owner-family` / `cross-owner`
- primary rail still red after repair

Allowed actions in Phase 1:

- record structured escalation decision
- optionally route to wider search / branch-search only behind explicit knob and budget cap

This ticket keeps widening explainable and bounded.

## Touch files

- `src/agent/repair-escalation.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/eval/repair/index.ts`
- `src/runner/batch/types.ts`
- new `tests/unit/repair-escalation.test.ts`
- new `tests/integration/bench-repair-escalation.test.ts`

## Acceptance criteria

- [ ] No escalation without `primary rail still red`.
- [ ] No escalation on a lone uncorroborated stage-1 file hit.
- [ ] `owner-family` and corroborated multi-owner cases can trigger widening under cap.
- [ ] Decision is serialized for diagnostics even when widening stays OFF.
- [ ] OFF path remains byte-identical.

## Hellgates

- `bun test tests/unit/repair-escalation.test.ts`
- `bun test tests/integration/bench-repair-escalation.test.ts`

Red cases this ticket must pin:

- widening triggers on heuristic ambiguity alone
- repair keeps looping locally despite explicit multi-owner evidence
- escalation decision is computed from data different from the bundle seen by gate/prompt

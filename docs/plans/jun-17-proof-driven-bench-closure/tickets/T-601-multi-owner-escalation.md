# T-601: multi-owner escalation decision

**Priority:** P1 · **Size:** M · **Deps:** [T-202](T-202-owner-admission-first-edit.md), [T-301](T-301-verification-plan.md), [T-401](T-401-patch-hygiene-gate.md) · **Posture:** OFF (`repair-escalation` knob / `QUANTA_BENCH_REPAIR_ESCALATION`)

## Deliverable

Add an explicit `RepairEscalationDecision` that chooses among:

- `continue-single-owner`
- `collect-more-evidence`
- `branch-search`
- `multi-owner-plan`

The decision must be derived from:

- `FaultEvidencePacket`
- `VerificationPlan`
- `PatchHygieneReport`

and always carry a structured `reason`.

## Touch files

- new `src/agent/repair-escalation/types.ts`
- new `src/agent/repair-escalation/policy.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/report.ts`
- new `tests/unit/repair-escalation.test.ts`
- new `tests/integration/bench-repair-escalation.test.ts`

## Acceptance criteria

- [ ] No branching on `instance_id`, django package names, or hidden labels.
- [ ] No escalation is triggered by same-model discomfort alone; artifact evidence must justify the action.
- [ ] Branch-search / subagent are never activated without an explicit escalation decision.
- [ ] Multi-owner evidence is reported, not hidden inside prompt prose.
- [ ] V1 reason taxonomy is closed and explicit (for example: `owner_unresolved`, `cross_file_conflict`, `primary_rail_red_no_progress`, `hygiene_conflict`).
- [ ] Report artifact records the chosen escalation action and reason.

## Proof rail

- `bun test tests/unit/repair-escalation.test.ts`
- `bun test tests/integration/bench-repair-escalation.test.ts`

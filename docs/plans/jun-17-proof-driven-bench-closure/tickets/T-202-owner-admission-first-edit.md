# T-202: owner admission + first-edit telemetry

**Priority:** P1 · **Size:** M · **Deps:** [T-201](T-201-fault-evidence-packet.md) · **Posture:** rides `fault-evidence`

## Deliverable

Turn `FaultEvidencePacket` into an explicit owner-admission decision:

- `high` confidence single owner -> inject one concise "first edit candidate" line
- low confidence / multi-owner -> no forced owner, continue evidence-first

Also record whether the first mutating edit matched the admitted owner.

## Touch files

- new `src/agent/fault-evidence/owner-admission.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts` — prod wrapper / stream-tap host (firstEdit capture)
- `src/agent/stream-callbacks.ts` — first mutating tool_call observation seam
- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- new `tests/unit/owner-admission.test.ts`
- new `tests/integration/bench-owner-admission.test.ts`

> `firstEditOwnerMatch` is recorded HERE but the first-mutating-edit event is
> captured at the stream-tap seam (`src/apps/bench/eval/driver.ts` +
> `src/agent/stream-callbacks.ts`), shared with T-302. It is NOT derivable from
> the final diff. The runner-core driver (`src/runner/batch/eval/driver.ts`) is
> the engine; the apps wrapper hosts the production stream tap — both are touched.

## Acceptance criteria

- [ ] Single high-confidence owner injects one prompt line before the base task text.
- [ ] Ambiguous owner does not hard-block edits by itself.
- [ ] Telemetry records admitted owner and `firstEditOwnerMatch`.
- [ ] No new dispatch-time deny is introduced in this ticket.

## Proof rail

- `bun test tests/unit/owner-admission.test.ts`
- `bun test tests/integration/bench-owner-admission.test.ts`

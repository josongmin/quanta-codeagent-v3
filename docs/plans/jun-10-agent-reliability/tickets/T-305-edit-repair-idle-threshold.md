# T-305: edit-repair-loop idleThreshold early-stop (Cursor absorb)

**RFC:** [03·W5](../03-rfc-post-edit-regression-guards.md) · **Priority:** P2 · **Size:** S · **Deps:** none · **Posture:** rides existing `QUANTA_EDIT_REPAIR_LOOP` gate

## Deliverable
Adopt Cursor's verified `idleThreshold` semantics (corpus: `ClientContinuationConfig` — maxLoops + idleThreshold early-stop) into `src/agent/edit-repair-loop/runner.ts`: stop the bounded repair loop early when an iteration makes **no progress** — deterministic equality check (identical diagnostics set two iterations running), NOT a tuned threshold. New stop reason `"no-progress"` added to the closed `RepairStopReason` union.

## Acceptance criteria
- [ ] Unit: identical diagnostics two-in-a-row → `stop: "no-progress"`, iterations logged.
- [ ] Existing stop reasons/behavior unchanged; progressing loops unaffected.

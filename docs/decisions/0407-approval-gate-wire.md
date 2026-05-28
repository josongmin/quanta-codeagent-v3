# ADR-0407 — Approval-gate wire (attribute HITL to Objective + RunLedger)

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/approval-gate-wire/` (new: `types.ts` + `wire.ts` +
`index.ts`) + hellgate + surgical `src/agent/admissibility-gate.ts` wire
**Default-OFF:** Yes — without `opts.approvalStateMachine` the gate adapter is a
byte-identical legacy resolver passthrough (no SM calls, `approvalId === ""`).

## Context

ADR-0403 shipped a closed `ApprovalStateMachinePort` with `request` / `settle` /
`cancel` that attributes pauses to the per-thread Objective (ADR-0394) +
unified Run Ledger (ADR-0395). At ship time **no production code called it** —
`admissibility-gate.ts` invoked `reviewAction` (the HITL reviewer port)
directly, so the WHY-stopped state was invisible to any surface that consults
Objective.blockers or Ledger.waiting().

The gap is small but structurally important: a UI rendering *"the agent is
waiting on you"* had to reconcile reviewer state against three other slices,
and pauses for permission/clarification/escalation never landed as first-class
records.

## Decision

Introduce a tiny closed adapter slice — `approval-gate-wire` — that wraps an
`ApprovalStateMachinePort.request` + `settle` pair around a host-supplied HITL
resolver. The admissibility-gate imports the adapter and uses it at exactly
one site (`reviewAndDecide`); the slice itself imports only TYPES from
`@/agent/approval-state-machine` (no inbound dep on admissibility-gate, the
relationship is strictly one-way).

### Adapter port

```ts
ApprovalGatePort = {
  open(req, resolver): Promise<{ approvalId, decision, modifiedAction? }>
  cancel(approvalId): void
}
createApprovalGate({ approvalSM?, now? }): ApprovalGatePort
```

### Behavior matrix

| approvalSM | resolver behavior     | gate behavior                       |
|------------|-----------------------|-------------------------------------|
| undefined  | resolves any decision | legacy passthrough, approvalId=""   |
| undefined  | throws                | rethrow, no SM calls                |
| present    | resolves "approve"    | request + settle("approve")         |
| present    | resolves "deny"       | request + settle("deny")            |
| present    | resolves "modify"     | request + settle("modify",{mod})    |
| present    | throws                | settle("deny") best-effort + rethrow|
| present    | request() throws      | resolver still runs, approvalId=""  |
| present    | settle() throws       | resolution still returned           |

### Invariants

- **NO-THROW at the SM boundary.** A hostile / misbehaving `ApprovalStateMachinePort` cannot perturb the gate's contract — SM exceptions are swallowed. Resolver throws DO propagate (the resolver's exception is the existing dispatch contract; the gate best-effort settles `"deny"` before re-throwing).
- **Default-OFF.** Absent `approvalSM` ⇒ `open(req, resolver)` invokes `resolver(req)` and returns the decision with `approvalId === ""`. Zero allocation, zero SM calls.
- **Frozen returns.** `ApprovalGateResolution` is `Object.freeze`'d — callers cannot perturb internal state through a held reference.
- **Slice fence.** Imports allowed = `@/agent/approval-state-machine` (TYPES ONLY). NO `@/agent/admissibility-gate`, NO `@/agent/loop`, NO `@/agent/dispatch`, NO `@/agent/types`, NO `@/apps`, NO `@/tool`.
- **Verbatim payload forwarding.** `threadId`/`kind`/`reason`/`proposedAction`/`resumeStep`/`options` reach `SM.request` unchanged.
- **`approvalId` round-trip.** The id surfaced in the resolution is exactly the id `SM.request` minted (synthetic SM stubs that pin the id are honored).
- **Concurrent isolation.** Parallel `open()` calls don't conflate IDs; each `settle` targets its own approval id.

### Wire site (admissibility-gate)

Inside `reviewAndDecide`, the call to `reviewAction(keyed, ctx, opts.reviewerPort)` is wrapped by `gate.open({...}, async () => reviewAction(...))`. The closure captures the full multi-verb `ReviewDecision` for the downstream `isAllowed`/`denyReviewedAction` paths (the SM only needs the 3-arm `approve`/`deny`/`modify` reduction, but the gate is purely additive — `dec` continues to carry the verb verbatim).

The `opts.approvalStateMachine` slot was added to `AdmissibilityWaveAOptions` (defined in `admissibility-gate.ts` itself — not in `src/agent/types.ts`, which stays untouched). A host opting into attribution sets `config.admissibility.approvalStateMachine = createApprovalStateMachine({ objective, ledger })`; everyone else gets the byte-identical legacy path.

The gate's wire diff is **30 lines, additive, no logic mutation** — the resolver still drives `reviewAction` once with the same arguments, the downstream illegal-verb / allow / deny branches are untouched.

### Mapping (reviewer → 3-arm)

- `dec.outcome` satisfies `isAllowed(...)` ⇒ resolver returns `"approve"`
- otherwise ⇒ resolver returns `"deny"`

`"modify"` is reserved for resolvers that genuinely rewrite the action (a future host might surface a richer reviewer UI that returns a modified command). The reviewer port today does not expose this verb, so the wire stays on the 2-arm subset until/unless a `modify`-capable reviewer ships.

## Consequences

**Gains.**

- Every reviewer escalation lands as a first-class `ApprovalRequest` with `kind: "permission" | "escalation"` (rule-ask vs always-confirm-tier respectively), `reason: "${origin}-escalation:${tool}"`, `proposedAction: actionKey`, `resumeStep: "dispatch:${call.id}"`.
- The Objective blocker / Run Ledger waiting entry are populated automatically by the SM at `request` and cleared at `settle` — the surface gets ONE place to render "waiting on you" with the WHY + the resume hint.
- A future `subagent-background` background runner can `gate.cancel(approvalId)` on parent abort to close out abandoned approvals without touching the gate body.

**Trade-offs.**

- The SM mints one record per reviewer escalation (≈ 200 bytes) — opt-in cost; default-OFF removes it.
- The wire today reduces reviewer verbs to `approve`/`deny` (the SM doesn't see allowlist_commands vs allowlist_domain). The downstream gate still consumes the full verb via closure — only the attribution record loses the distinction. Acceptable: the attribution record's `decision` answers *"was the agent allowed to proceed"*, not *"by what rule"*.

**Non-goals (this ADR).**

- Wiring `request_user_input` (the typed Q&A tool) through the adapter — it has a different return shape (`UserInputOutcome` 2-arm) and a separate ctx-plumbed resolver. A follow-up ADR can route it through `open()` once a host opts in.
- Persistence — the SM is in-memory; snapshot/restore lives in ADR-0403.
- UI rendering — the surface consumes Objective.blockers + Ledger.waiting() directly; this ADR does not introduce a new emit channel.

## Tests

- `tests/unit/approval-gate-wire-hellgate.test.ts` — 21 cases / 61 expects, covers all rows of the behavior matrix + concurrent isolation + frozen-return + verbatim-payload-forwarding + composition smoke with real SM.
- `tests/unit/admissibility-hellgate.test.ts`, `tests/unit/admissibility-gate.test.ts`, `tests/unit/hitl-*.test.ts` — 171 cases / 383 expects all pass with the wire applied (default-OFF byte-identical).

## Files

- `src/agent/approval-gate-wire/types.ts` (port + payload types)
- `src/agent/approval-gate-wire/wire.ts` (the adapter factory)
- `src/agent/approval-gate-wire/index.ts` (barrel)
- `src/agent/admissibility-gate.ts` (+30 lines: opts slot + gate wrap at `reviewAndDecide`)
- `tests/unit/approval-gate-wire-hellgate.test.ts`
- `tools/feature-catalog/features/09-integration/approval-gate-wire.yaml`

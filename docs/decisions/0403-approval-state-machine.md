# ADR-0403 — Approval state machine (port + store)

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/approval-state-machine/` (new: `types.ts` + `store.ts` +
`index.ts`) + hellgate
**Default-OFF:** Yes — pure new slice, imported by nobody. Importing the barrel
touches no process state and pulls in zero peer slices. This wave is the
**PORT + STORE** layer; wiring into `admissibility-gate.ts` /
`request_user_input` is a follow-up.

## Context

quanta already has HITL (`hitl-tier`, `request_user_input`, the
`always-confirm` / `hand-off-required` tiers) — the *mechanism* for stopping
the agent and asking the operator a question. What it does **not** have is a
first-class state model for that stop:

1. When the agent halts, the operator does not see **why now** in one place —
   the reason is a free-form prompt string.
2. There is no typed record of **which step resumes after approval** — the
   resume hint is derived ad-hoc from scrollback.
3. The pause is invisible to the per-thread Objective (ADR-0394) and the
   unified Run Ledger (ADR-0395). A surface that wants to render *"the agent
   is waiting on you"* has to reconcile HITL state against three other slices.

That is the structural gap this ADR closes — a closed port + in-memory store
that wraps approval / clarification requests as first-class records and
attributes them to both `Objective.blockers` and `RunLedger.waiting()`.

## Decision

Introduce a closed `ApprovalStateMachinePort` + in-memory
`createApprovalStateMachine` factory. The model is a small, fully readonly
record:

```ts
ApprovalRequest = {
  id, threadId, kind, reason, proposedAction, resumeStep,
  options?, status, createdAt, settledAt?, decision?, modifiedAction?,
  blockerId?, runEntryId?,
}
```

- `kind = "permission" | "clarification" | "escalation"`
- `decision = "approve" | "deny" | "modify"`
- `status = "pending" | "approved" | "denied" | "expired" | "cancelled"`

### Port shape

`request` / `settle` / `expire` / `cancel` / `get` / `list` / `pending` /
`toSnapshot` / `fromSnapshot`. **Every method is NO-THROW.** Unknown id ⇒
`null` on mutators / `null` on `get`. IDs are minted internally via
`crypto.randomUUID()` — callers never supply one. A `now` clock seam is
injected via `createApprovalStateMachine({ now })` for deterministic tests.

### Status transitions (pinned by hellgate)

- `request` ⇒ `"pending"` with `createdAt` stamped.
- `settle(approve|modify)` ⇒ `"approved"` (idempotent on already-settled —
  re-settle returns the entry unchanged; `settledAt` is not re-bumped).
- `settle(deny)` ⇒ `"denied"`.
- `expire` from `pending` ⇒ `"expired"`; no-op on already-settled.
- `cancel` from `pending` ⇒ `"cancelled"`; no-op on already-settled.
- Any mutator on unknown id ⇒ `null`, no exception.

### Attribution invariants

When the optional `objective` / `ledger` ports are supplied via
`createApprovalStateMachine({ objective, ledger })`:

- `request()` calls `objective.addBlocker({ reason, waitingOn: "user" })` and
  captures the **newest** blocker id as `blockerId` on the request.
- `request()` calls `ledger.start({ id: <approvalId>, kind: "exec",
  owner: threadId, title: reason, resumeAction: resumeStep })` then
  `ledger.touch(id, { status: "waiting", waitingOn: "user" })` and captures the
  approval id as `runEntryId`.
- `settle()` / `expire()` / `cancel()` MUST clear the matched objective
  blocker AND call `ledger.settle(id, "completed" | "stopped")` mapped from
  the decision:
  - `approve` / `modify` ⇒ `completed`
  - `deny` / `expired` / `cancelled` ⇒ `stopped`

When the optional ports are absent, attribution is a compile-time-noop — the
approval state itself still tracks correctly.

### Hostile-port invariant (load-bearing)

Attribution is **best-effort**. A misbehaving / hostile `objective.addBlocker`
or `ledger.start` / `touch` / `clearBlocker` / `settle` MUST NOT break the
approval state. Every attribution call is wrapped in `try/catch` and a throw
degrades to `blockerId` / `runEntryId` being absent — the approval record is
still recorded and still transitions correctly. The hellgate pins this with
hostile fakes that throw from every method.

### Slice fence

Imports allowed: `node:crypto`, `@/agent/objective` (TYPES ONLY),
`@/agent/run-ledger` (TYPES ONLY), and the slice's own files. NO `@/agent`
core (`loop` / `dispatch` / `prompt` / `features` / `types`), NO `@/apps`, NO
`@/tool`, NO sibling slices. The slice is a self-contained pure model.

## Consequences

- **+** First-class typed pause: a single surface can render *"the agent is
  waiting on you, here is why, here is what resumes"* by reading three already-
  closed ports (Objective + RunLedger + ApprovalStateMachine).
- **+** Default-OFF & byte-identical: nothing wires the machine yet, so this
  wave cannot regress any existing behaviour. Existing HITL /
  `request_user_input` code is UNCHANGED.
- **+** Attribution is opt-in: callers can wire to one port, both, or neither.
  Approval state is authoritative — a misbehaving attribution port cannot
  corrupt it.
- **−** Wiring is deferred. Until a follow-up wave plumbs the
  admissibility-gate / request_user_input into `request` + `settle`, the
  machine is an empty model. That is intentional — this ADR is the contract
  the wiring will target.

## Alternatives considered

- **Extend the HITL tier registry with a status field.** Rejected: the HITL
  tier registry annotates *tool-class* policy (always-confirm vs
  hand-off-required) — it does not model per-request lifecycle and has no
  notion of `expire` / `cancel`. Overloading it would couple two concerns.
- **Surface-side aggregator that reconciles HITL prompt state with Objective
  + RunLedger.** Rejected: pushes the reconciliation (and three slice
  dependencies) into every UI; the model belongs in the core, not duplicated
  per surface.
- **Persist approval state inline on the Objective blocker.** Rejected: a
  blocker is not always a user-facing approval (it can be `waitingOn: "tool"`
  / `"network"` / `"child_agent"`), and an approval has its own lifecycle
  (expire / cancel) that has no analogue on a blocker.

## Tests

`tests/unit/approval-state-machine-hellgate.test.ts` — 44 hellgate cases /
110 expects. Pins:

- `request` shape (status / createdAt / minted id / kind coercion / options
  cap at 3 / `options` absent ⇒ omitted).
- `settle` / `expire` / `cancel` transitions per kind, including idempotency.
- Unknown id ⇒ null on all mutators (no throw).
- Attribution WITH objective + ledger ports — blockerId captured, ledger
  entry transitioned to `waiting`, blocker cleared on settle, ledger settled
  to `completed` (approve/modify) or `stopped` (deny/expire/cancel).
- Attribution WITHOUT optional ports — request still tracks; both partial
  combinations (only objective / only ledger) covered.
- Hostile fakes that throw from every method of objective / ledger do not
  propagate; approval state still transitions.
- Throwing clock falls back to a safe stamp.
- Snapshot round-trip (replace-not-merge); malformed snapshot / hostile
  entries silently dropped.
- Multi-thread isolation (list / pending filters compose status ∧ threadId).
- Frozen returns (record + list array).
- NO-THROW on hostile inputs across all methods.

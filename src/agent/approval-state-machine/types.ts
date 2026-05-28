/**
 * ADR-0399 — Approval state machine (types).
 *
 * quanta's HITL / `request_user_input` already lets the agent stop and ask the
 * user a question, but the *product experience* is weak: when the agent halts
 * for approval the operator does not see (a) WHY now, (b) exactly which step
 * resumes after approval, (c) the pause attributed to the per-thread Objective
 * (ADR-0394) or to the Run Ledger (ADR-0395).
 *
 * This slice closes that gap with a CLOSED port + in-memory store that wraps
 * approval / clarification requests as first-class records and attributes the
 * pause to:
 *   - `Objective.blockers` (waitingOn:"user") via `ObjectivePort.addBlocker` /
 *     `clearBlocker` (ADR-0394).
 *   - `RunLedger.waiting()` via `RunLedgerPort.start` + `touch` + `settle`
 *     (ADR-0395), so a single UI surface can render the pause across all
 *     long-running work.
 *
 * Slice fence: imports allowed = `@/agent/objective` (types) + `@/agent/run-ledger`
 * (types) + `@/shared`. NO `@/agent` core, NO `@/apps`, NO `@/tool`. Pure data +
 * a closed port. The store is the only mutator.
 *
 * THIS WAVE IS THE PORT + STORE LAYER. The slice is NOT yet wired into
 * `admissibility-gate.ts` / `request_user_input`. Existing HITL code is
 * UNCHANGED — wiring is a follow-up wave.
 *
 * exactOptional: optional fields are OMITTED when absent (never `: undefined`).
 */

/** What flavour of approval the agent is asking for.
 *
 *  - `permission`    — pre-execute gate for a mutating tool / boundary action.
 *  - `clarification` — mid-turn question (ambiguous goal, missing parameter).
 *  - `escalation`    — terminal halt requiring an operator decision; closer to
 *                      HITL `hand-off-required`.
 */
export type ApprovalKind = "permission" | "clarification" | "escalation"

/** What the user decided.
 *
 *  - `approve` — proceed with `proposedAction` verbatim.
 *  - `deny`    — refuse; the agent must not execute `proposedAction`.
 *  - `modify`  — proceed with `modifiedAction` instead of `proposedAction`.
 */
export type ApprovalDecision = "approve" | "deny" | "modify"

/** Lifecycle status of an approval request. `pending` is the only mutable
 *  status; `approved` / `denied` / `expired` / `cancelled` are terminal. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled"

/** A single approval record.
 *
 *  IDs are minted internally via `crypto.randomUUID()` — callers never supply
 *  one. `blockerId` / `runEntryId` are populated only when the matching port
 *  (objective / ledger) was supplied to `createApprovalStateMachine` AND the
 *  attribution call did not throw.
 *
 *  All fields are readonly: returned records are frozen so a reader cannot
 *  mutate machine state by holding a reference. */
export interface ApprovalRequest {
  /** Unique approval id (caller never supplies — minted via `crypto.randomUUID`). */
  readonly id: string
  /** Thread that initiated the approval — drives Objective attribution. */
  readonly threadId: string
  readonly kind: ApprovalKind
  /** User-facing string: WHY the agent stopped right now. */
  readonly reason: string
  /** Exact action that will execute upon `approve` (e.g. command preview). */
  readonly proposedAction: string
  /** Human-readable step label the agent will resume from after approval. */
  readonly resumeStep: string
  /** Optional clarification options (max 3) for `modify`-style decisions. */
  readonly options?: readonly string[]
  readonly status: ApprovalStatus
  readonly createdAt: number
  /** Stamped when the request transitions out of `pending`. */
  readonly settledAt?: number
  readonly decision?: ApprovalDecision
  /** Populated only when `decision === "modify"`. */
  readonly modifiedAction?: string
  /** Back-ref to the Objective blocker (only when attribution succeeded). */
  readonly blockerId?: string
  /** Back-ref to the Run Ledger entry (only when attribution succeeded). */
  readonly runEntryId?: string
}

/** Serializable point-in-time view of every approval in a machine. */
export interface ApprovalSnapshot {
  readonly approvals: readonly ApprovalRequest[]
}

/**
 * Closed port over the approval state machine.
 *
 * EVERY method is NO-THROW. Unknown id ⇒ `null` on mutators / `null` on `get`.
 * `now` is an injected clock seam (default `Date.now`) for deterministic tests.
 *
 * Attribution invariants:
 *   - `request()` MAY attribute the pause to the injected ports:
 *       - `objective.addBlocker({ reason, waitingOn: "user" })` — the returned
 *         Objective's NEWEST blocker id is captured as `blockerId`.
 *       - `ledger.start({ id, kind: "exec", owner: threadId, title: reason,
 *                         resumeAction: resumeStep })`
 *         then `ledger.touch(id, { status: "waiting", waitingOn: "user" })` —
 *         the entry id is captured as `runEntryId`.
 *   - `settle()` MUST:
 *       - clear the objective blocker via `clearBlocker(threadId, blockerId)`
 *         (when present), and
 *       - call `ledger.settle(id, "completed" | "stopped")` mapped from the
 *         decision: `approve` / `modify` ⇒ `completed`,
 *                   `deny` ⇒ `stopped`.
 *     `expire` ⇒ `stopped`. `cancel` ⇒ `stopped`.
 *   - When `deps.objective` / `deps.ledger` are absent, attribution is a
 *     compile-time-noop: the approval state itself still tracks correctly.
 *   - Attribution failure (a misbehaving objective / ledger port throws) MUST
 *     NOT break the approval state — the request is still recorded with no
 *     `blockerId` / `runEntryId`.
 *
 * Status transitions (pinned by hellgate):
 *   - `request`                       ⇒ `"pending"`
 *   - `settle(approve|modify)`        ⇒ `"approved"`  (sets decision + settledAt;
 *                                                     idempotent on already-settled)
 *   - `settle(deny)`                  ⇒ `"denied"`
 *   - `expire` from `pending`         ⇒ `"expired"`   (no-op if already settled)
 *   - `cancel` from `pending`         ⇒ `"cancelled"` (no-op if already settled)
 *   - Any mutator on unknown id       ⇒ `null`        (no exception)
 */
export interface ApprovalStateMachinePort {
  request(req: {
    threadId: string
    kind: ApprovalKind
    reason: string
    proposedAction: string
    resumeStep: string
    options?: readonly string[]
  }): ApprovalRequest

  settle(
    id: string,
    decision: ApprovalDecision,
    opts?: { modifiedAction?: string },
  ): ApprovalRequest | null

  expire(id: string): ApprovalRequest | null

  cancel(id: string): ApprovalRequest | null

  get(id: string): ApprovalRequest | null

  list(filter?: { status?: ApprovalStatus; threadId?: string }): readonly ApprovalRequest[]

  pending(): readonly ApprovalRequest[]

  toSnapshot(): ApprovalSnapshot

  /** Replace all approvals from a snapshot (not a merge). Malformed entries
   *  are silently dropped; a malformed snapshot is a no-op. */
  fromSnapshot(snap: ApprovalSnapshot): void
}

/**
 * ADR-0512 P3 — pending session approvals (the escalation-card backing state).
 *
 * The session protocol surfaces an approval the agent is waiting on as an
 * `approval.requested` event carrying a `PendingApprovalView` (which the daemon
 * now enriches with `scopeContext` on a skill-scope escalation), and clears it
 * with `approval.resolved`. The transcript reducer already renders a one-line
 * system note for these; this reducer tracks the LIVE pending set so the
 * `EscalationCard` can render the interactive approval (and the user can answer
 * via `approval.respond`).
 *
 * PURE + exported so the add/clear/dedup invariants are unit-testable in the
 * node test env (no DOM). The React hook below is a thin `useReducer` shell.
 */

import { useEffect, useReducer } from "react"
import type { PendingApprovalView, SessionEvent } from "../types/protocol"
import type { SessionClient } from "./client"

export interface PendingApprovalsState {
  readonly approvals: readonly PendingApprovalView[]
}

export const initialPendingApprovals: PendingApprovalsState = { approvals: [] }

/**
 * Fold one session event into the pending-approvals set. `approval.requested`
 * adds (dedup by `approvalId` so a hydration/replay overlap never double-adds);
 * `approval.resolved` removes the matching id. Every other event is a no-op and
 * returns the SAME reference (so a consumer's memo / effect does not churn).
 */
export const applyApprovalEvent = (
  state: PendingApprovalsState,
  event: SessionEvent,
): PendingApprovalsState => {
  if (event.type === "approval.requested") {
    if (state.approvals.some((a) => a.approvalId === event.approval.approvalId)) {
      return state
    }
    return { approvals: [...state.approvals, event.approval] }
  }
  if (event.type === "approval.resolved") {
    const next = state.approvals.filter((a) => a.approvalId !== event.approvalId)
    return next.length === state.approvals.length ? state : { approvals: next }
  }
  return state
}

type PendingApprovalsAction =
  | { readonly type: "event"; readonly event: SessionEvent }
  | { readonly type: "drop"; readonly approvalId: string }
  | { readonly type: "reset" }

const pendingApprovalsReducer = (
  state: PendingApprovalsState,
  action: PendingApprovalsAction,
): PendingApprovalsState => {
  switch (action.type) {
    case "event":
      return applyApprovalEvent(state, action.event)
    case "drop":
      return applyApprovalEvent(state, {
        eventId: `local-drop-${action.approvalId}`,
        seq: 0,
        revision: 0,
        emittedAt: new Date().toISOString(),
        type: "approval.resolved",
        approvalId: action.approvalId,
        decision: "approve",
      })
    case "reset":
      return initialPendingApprovals
    default:
      return state
  }
}

/**
 * `usePendingApprovals` — mirrors the live pending-approval set from the
 * session event stream. Returns the current approvals plus an optimistic
 * `dismiss(approvalId)` the surface calls right after it sends `approval.respond`
 * (so the card disappears immediately; the authoritative `approval.resolved`
 * event then arrives and is a no-op for the already-removed id).
 */
export const usePendingApprovals = (
  client: SessionClient,
): {
  readonly approvals: readonly PendingApprovalView[]
  readonly dismiss: (approvalId: string) => void
} => {
  const [state, dispatch] = useReducer(pendingApprovalsReducer, initialPendingApprovals)
  useEffect(() => {
    const unsub = client.onAny((event: SessionEvent) => {
      dispatch({ type: "event", event })
    })
    return unsub
  }, [client])
  return {
    approvals: state.approvals,
    dismiss: (approvalId: string) => dispatch({ type: "drop", approvalId }),
  }
}

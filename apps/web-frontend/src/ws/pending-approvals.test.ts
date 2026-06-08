import { describe, expect, it } from "vitest"
import type { PendingApprovalView, SessionEvent } from "../types/protocol"
import { applyApprovalEvent, type PendingApprovalsState } from "./pending-approvals"

const EMPTY: PendingApprovalsState = { approvals: [] }

const requested = (
  approval: PendingApprovalView,
): Extract<SessionEvent, { type: "approval.requested" }> => ({
  eventId: `req-${approval.approvalId}`,
  seq: 1,
  revision: 1,
  emittedAt: "2026-06-09T00:00:00.000Z",
  type: "approval.requested",
  approval,
})

const resolved = (approvalId: string): Extract<SessionEvent, { type: "approval.resolved" }> => ({
  eventId: `res-${approvalId}`,
  seq: 2,
  revision: 1,
  emittedAt: "2026-06-09T00:00:01.000Z",
  type: "approval.resolved",
  approvalId,
  decision: "approve",
})

const plainApproval: PendingApprovalView = {
  approvalId: "a-1",
  reason: "shell command approval",
  requestedAt: "2026-06-09T00:00:00.000Z",
}

const escalationApproval: PendingApprovalView = {
  approvalId: "a-2",
  reason: "approval required",
  requestedAt: "2026-06-09T00:00:00.000Z",
  scopeContext: {
    tool: "edit",
    activeSkill: "localize-fault",
    reason: "out of scope",
    risk: "mutating",
  },
}

describe("pending approvals reducer (session protocol)", () => {
  it("adds an approval on approval.requested", () => {
    const next = applyApprovalEvent(EMPTY, requested(plainApproval))
    expect(next.approvals).toHaveLength(1)
    expect(next.approvals[0]?.approvalId).toBe("a-1")
    expect(next.approvals[0]?.scopeContext).toBeUndefined()
  })

  it("retains the scopeContext on an escalation approval", () => {
    const next = applyApprovalEvent(EMPTY, requested(escalationApproval))
    expect(next.approvals[0]?.scopeContext?.tool).toBe("edit")
    expect(next.approvals[0]?.scopeContext?.activeSkill).toBe("localize-fault")
  })

  it("removes an approval on approval.resolved (matching id)", () => {
    const added = applyApprovalEvent(EMPTY, requested(escalationApproval))
    const cleared = applyApprovalEvent(added, resolved("a-2"))
    expect(cleared.approvals).toHaveLength(0)
  })

  it("is a no-op for unrelated events (no transcript churn)", () => {
    const unrelated: SessionEvent = {
      eventId: "t-1",
      seq: 3,
      revision: 1,
      emittedAt: "2026-06-09T00:00:02.000Z",
      type: "turn.completed",
      outcomeReason: "done",
    }
    const next = applyApprovalEvent(EMPTY, unrelated)
    expect(next).toBe(EMPTY)
  })

  it("dedups a re-requested approval id (idempotent on replay overlap)", () => {
    const once = applyApprovalEvent(EMPTY, requested(escalationApproval))
    const twice = applyApprovalEvent(once, requested(escalationApproval))
    expect(twice.approvals).toHaveLength(1)
  })
})

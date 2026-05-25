import { describe, expect, test } from "bun:test"
import { createOnConfirmReviewerPort } from "@/agent"
import { ReviewerUnavailableError, type ReviewContext, type ToolActionKeyed } from "@/permission"

const action: ToolActionKeyed = {
  tool: "dangerous",
  input: { path: "src/app.ts" },
  isReadOnly: false,
  actionKey: "dangerous",
}

const ctx: ReviewContext = {
  sessionId: "s1",
  turnId: "1",
  priorDenials: [],
  configReviewer: "user",
  decidedAt: 42,
  reviewKind: "edit",
}

describe("createOnConfirmReviewerPort", () => {
  test("maps allow/deny_and_steer through the ReviewerPort contract", async () => {
    const approve = createOnConfirmReviewerPort({ onConfirm: async () => true })
    const approved = await approve.userReview(action, ctx)
    expect(approved.reviewer).toBe("user")
    expect(approved.outcome).toBe("user_approved")
    expect(approved.rationale).toContain("edit review for dangerous")

    const denyAndSteer = createOnConfirmReviewerPort({
      onConfirm: async () => ({ decision: "deny_and_steer", steer: "Use grep first." }),
    })
    const denied = await denyAndSteer.userReview(action, ctx)
    expect(denied.outcome).toBe("user_denied")
    expect(denied.verb).toEqual({ verb: "reject_and_tell", message: "Use grep first." })
  })

  test("fails closed for unsupported higher-tier reviewers", async () => {
    const port = createOnConfirmReviewerPort({ onConfirm: async () => true })
    await expect(port.autoReview(action, { ...ctx, configReviewer: "auto_review" })).rejects.toThrow(
      ReviewerUnavailableError,
    )
    await expect(
      port.guardianReview(action, { ...ctx, configReviewer: "guardian_subagent" }),
    ).rejects.toThrow(ReviewerUnavailableError)
  })
})

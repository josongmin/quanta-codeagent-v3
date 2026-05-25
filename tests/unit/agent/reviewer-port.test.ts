import { describe, expect, test } from "bun:test"
import { createOnConfirmReviewerPort } from "@/agent"
import { ReviewerUnavailableError, type ReviewContext, type ToolActionKeyed } from "@/permission"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"

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

  test("uses classifier allow and escalates blocked auto-review decisions to user review", async () => {
    let classifyCalls = 0
    const userPort = createOnConfirmReviewerPort({ onConfirm: async () => true })
    const autoReview = createClassifierBackedAutoReview({
      classify: async ({ tool }) => {
        classifyCalls += 1
        return tool === "safe"
          ? { verdict: "allow", reason: "Allowed by classifier" }
          : { verdict: "block", reason: "Needs human review" }
      },
      userReview: userPort.userReview,
    })

    const readOnly = await autoReview(
      { ...action, tool: "read_file", isReadOnly: true, actionKey: "read_file" },
      { ...ctx, configReviewer: "auto_review" },
    )
    expect(readOnly.reviewer).toBe("auto_review")
    expect(readOnly.outcome).toBe("not_needed")

    const allowed = await autoReview(
      { ...action, tool: "safe", actionKey: "safe" },
      { ...ctx, configReviewer: "auto_review" },
    )
    expect(allowed.reviewer).toBe("auto_review")
    expect(allowed.outcome).toBe("config_allowed")

    const escalated = await autoReview(
      { ...action, tool: "unsafe", actionKey: "unsafe" },
      { ...ctx, configReviewer: "auto_review" },
    )
    expect(escalated.reviewer).toBe("user")
    expect(escalated.outcome).toBe("user_approved")
    expect(classifyCalls).toBe(3)
  })
})

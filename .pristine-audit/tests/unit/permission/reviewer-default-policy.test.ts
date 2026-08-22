import { describe, expect, test } from "bun:test"
import { selectDefaultReviewer } from "../../../src/permission"

describe("selectDefaultReviewer", () => {
  test("prefers auto_review when the classifier-backed reviewer is live", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "auto",
        sandboxProfile: "workspace-write",
        hasAutoReview: true,
        hasGuardianReview: true,
      }),
    ).toBe("auto_review")
  })

  test("selects guardian_subagent for default-mode workspace-write posture when guardian is live", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("guardian_subagent")
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "workspace-write-net",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("guardian_subagent")
  })

  test("explicit user authority beats auto and guardian capabilities", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
        permissionMode: "default",
        sandboxProfile: "workspace-write",
        hasAutoReview: true,
        hasGuardianReview: true,
      }),
    ).toBe("user")
  })

  test("explicit agent authority selects guardian for on-request workspace-write posture", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: {
          approvalPolicy: "on-request",
          approvalsReviewer: "agent",
        },
        permissionMode: "acceptEdits",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("guardian_subagent")
  })

  test("explicit agent authority falls back to auto_review when guardian posture is absent", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: {
          approvalPolicy: "always",
          approvalsReviewer: "agent",
        },
        permissionMode: "default",
        sandboxProfile: "danger-full-access",
        hasAutoReview: true,
        hasGuardianReview: true,
      }),
    ).toBe("auto_review")
  })

  test("autoReviewEnabled routes to guardian REGARDLESS of env sandbox posture (T03 opt-in)", () => {
    // QUANTA_AUTO_REVIEW / QUANTA_APPROVAL_LADDER=guardian-approvals. The agent
    // reviewer is selected even when the env sandboxProfile is the unset
    // "default" — the opt-in IS the operator's posture choice.
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "default",
        hasAutoReview: false,
        hasGuardianReview: true,
        autoReviewEnabled: true,
      }),
    ).toBe("guardian_subagent")
  })

  test("autoReviewEnabled with NO guardian capability falls back (never silent auto-approve)", () => {
    // A headless run with no subagent: the opt-in must NOT silently auto-approve
    // with no reviewer — it degrades to auto_review then user.
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "default",
        hasAutoReview: true,
        hasGuardianReview: false,
        autoReviewEnabled: true,
      }),
    ).toBe("auto_review")
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "default",
        hasAutoReview: false,
        hasGuardianReview: false,
        autoReviewEnabled: true,
      }),
    ).toBe("user")
  })

  test("autoReviewEnabled=false is byte-identical to the legacy selection", () => {
    // The default. Outside the legacy workspace-write posture ⇒ user.
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "default",
        hasAutoReview: false,
        hasGuardianReview: true,
        autoReviewEnabled: false,
      }),
    ).toBe("user")
  })

  test("keeps user as the fallback outside the default workspace-write posture", () => {
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "acceptEdits",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("user")
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "danger-full-access",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("user")
    expect(
      selectDefaultReviewer({
        threadPermission: undefined,
        permissionMode: "default",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: false,
      }),
    ).toBe("user")
  })
})

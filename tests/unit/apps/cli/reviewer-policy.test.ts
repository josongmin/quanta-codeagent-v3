import { describe, expect, test } from "bun:test"
import {
  parseCliReviewerSandboxProfile,
  selectDefaultReviewer,
} from "../../../../src/apps/cli/repl/reviewer-policy"

describe("parseCliReviewerSandboxProfile", () => {
  test("accepts the known raw profiles", () => {
    expect(parseCliReviewerSandboxProfile("default")).toBe("default")
    expect(parseCliReviewerSandboxProfile("off")).toBe("off")
    expect(parseCliReviewerSandboxProfile("read-only")).toBe("read-only")
    expect(parseCliReviewerSandboxProfile("workspace-write")).toBe("workspace-write")
    expect(parseCliReviewerSandboxProfile("workspace-write-net")).toBe("workspace-write-net")
    expect(parseCliReviewerSandboxProfile("danger-full-access")).toBe("danger-full-access")
  })

  test("unknown or empty values fail closed to default", () => {
    expect(parseCliReviewerSandboxProfile("bogus")).toBe("default")
    expect(parseCliReviewerSandboxProfile("")).toBe("default")
    expect(parseCliReviewerSandboxProfile(undefined)).toBe("default")
  })
})

describe("selectDefaultReviewer", () => {
  test("prefers auto_review when the classifier-backed reviewer is live", () => {
    expect(
      selectDefaultReviewer({
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
        permissionMode: "default",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("guardian_subagent")
    expect(
      selectDefaultReviewer({
        permissionMode: "default",
        sandboxProfile: "workspace-write-net",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("guardian_subagent")
  })

  test("keeps user as the fallback outside the default workspace-write posture", () => {
    expect(
      selectDefaultReviewer({
        permissionMode: "acceptEdits",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("user")
    expect(
      selectDefaultReviewer({
        permissionMode: "default",
        sandboxProfile: "danger-full-access",
        hasAutoReview: false,
        hasGuardianReview: true,
      }),
    ).toBe("user")
    expect(
      selectDefaultReviewer({
        permissionMode: "default",
        sandboxProfile: "workspace-write",
        hasAutoReview: false,
        hasGuardianReview: false,
      }),
    ).toBe("user")
  })
})

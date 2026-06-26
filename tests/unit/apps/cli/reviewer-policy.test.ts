import { describe, expect, test } from "bun:test"
import { parseCliReviewerSandboxProfile } from "../../../../src/apps/cli/repl/reviewer-policy"

// The `selectDefaultReviewer` DECISION logic moved to `@/permission` (see
// `tests/unit/permission/reviewer-default-policy.test.ts`). This surface module
// now owns only the `QUANTA_SANDBOX` env-literal parse.
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

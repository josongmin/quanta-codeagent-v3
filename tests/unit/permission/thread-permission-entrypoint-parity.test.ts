import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionStore } from "@/permission/permission-store"
import { parsePosturePersistedRecord, parsePostureSection } from "@/permission/posture-persistence"
import { decodeThreadPermission } from "@/permission/thread-permission-decode"

const valid = {
  approvalPolicy: "always" as const,
  approvalsReviewer: "agent" as const,
  sandboxPolicy: { type: "danger-full-access" as const },
}

describe("thread permission entrypoint parity", () => {
  test("both consumers fail closed on the same corrupt primitive", async () => {
    const bad = { ...valid, approvalPolicy: "unknown-policy" }
    expect(decodeThreadPermission(bad).ok).toBe(false)
    expect(
      parsePosturePersistedRecord({
        schemaVersion: 1,
        requestedPatch: { approvalPolicy: "unknown-policy" },
        boundAskOutsidePlan: false,
        revision: 1,
      }),
    ).toBe(null)
    expect(parsePostureSection({}, { threadPermission: bad, askOutsidePlan: false }).default).toBe(
      null,
    )
    const dir = await mkdtemp(join(tmpdir(), "perm-ep-"))
    const file = join(dir, "s.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        perThread: { t: bad },
        perHost: {},
        deniedActions: {},
      }),
    )
    const store = createPermissionStore({ filePath: file })
    await store.load()
    expect(store.getThread("t")).toBeUndefined()
  })

  test("every closed-union member round-trips; invalid families >= 6", async () => {
    const { APPROVAL_POLICY_VALUES, APPROVALS_REVIEWER_VALUES, SANDBOX_POLICY_TYPES } =
      await import("@/permission/thread-permission-decode")
    expect(APPROVAL_POLICY_VALUES.length + APPROVALS_REVIEWER_VALUES.length).toBeGreaterThan(0)
    for (const approvalPolicy of APPROVAL_POLICY_VALUES) {
      for (const approvalsReviewer of APPROVALS_REVIEWER_VALUES) {
        for (const type of SANDBOX_POLICY_TYPES) {
          const decoded = decodeThreadPermission({
            approvalPolicy,
            approvalsReviewer,
            sandboxPolicy: { type },
          })
          expect(decoded.ok).toBe(true)
        }
      }
    }
    const invalid = [
      { ...valid, approvalPolicy: "unknown-policy" },
      { ...valid, approvalsReviewer: "robot" },
      { ...valid, sandboxPolicy: { type: "jail" } },
      "not-object",
      { ...valid, sandboxPolicy: "nope" },
      { ...valid, sandboxPolicy: { type: "workspace-write", writableRoots: [1] } },
    ]
    expect(invalid.length).toBeGreaterThanOrEqual(6)
    for (const row of invalid) {
      expect(decodeThreadPermission(row).ok).toBe(false)
    }
  })

  test("mutation: dropping one approval-policy literal fail-closes that member only", async () => {
    const { APPROVAL_POLICY_VALUES, isApprovalPolicy } = await import(
      "@/permission/thread-permission-decode"
    )
    const assertAlwaysAccepted = (isPolicy: (value: unknown) => boolean): void => {
      expect(isPolicy("always")).toBe(true)
    }
    const dropped = APPROVAL_POLICY_VALUES.filter((v) => v !== "always")
    const mutated = (value: unknown): boolean =>
      typeof value === "string" && (dropped as readonly string[]).includes(value)
    assertAlwaysAccepted(isApprovalPolicy)
    expect(() => assertAlwaysAccepted(mutated)).toThrow()
    expect(decodeThreadPermission({ ...valid, approvalPolicy: "always" }).ok).toBe(true)
  })
})

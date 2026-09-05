import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionStore } from "@/permission/permission-store"
import { parsePosturePersistedRecord, parsePostureSection } from "@/permission/posture-persistence"
import {
  APPROVAL_POLICY_VALUES,
  APPROVALS_REVIEWER_VALUES,
  decodeThreadPermission,
  SANDBOX_POLICY_TYPES,
} from "@/permission/thread-permission-decode"

const valid = {
  approvalPolicy: "on-request" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "read-only" as const },
}

describe("thread permission decode", () => {
  test("closed unions have full cardinality", () => {
    expect(APPROVAL_POLICY_VALUES).toEqual(["never", "on-request", "on-failure", "always"])
    expect(APPROVALS_REVIEWER_VALUES).toEqual(["user", "agent"])
    expect(SANDBOX_POLICY_TYPES).toEqual(["danger-full-access", "read-only", "workspace-write"])
  })

  for (const policy of APPROVAL_POLICY_VALUES) {
    test(`accepts approvalPolicy=${policy}`, () => {
      const r = decodeThreadPermission({ ...valid, approvalPolicy: policy })
      expect(r.ok).toBe(true)
    })
  }

  test("unknown enum / null / scalar / missing fail", () => {
    expect(decodeThreadPermission({ ...valid, approvalPolicy: "sometimes" }).ok).toBe(false)
    expect(decodeThreadPermission(null).ok).toBe(false)
    expect(decodeThreadPermission("x").ok).toBe(false)
    expect(
      decodeThreadPermission({ approvalsReviewer: "user", sandboxPolicy: valid.sandboxPolicy }).ok,
    ).toBe(false)
  })
})

describe("thread permission entrypoint parity", () => {
  test("consumers = 2; invalid families >= 6", async () => {
    const invalid = [
      { ...valid, approvalPolicy: "nope" },
      null,
      1,
      { ...valid, sandboxPolicy: { type: "banana" } },
      { approvalPolicy: "never" },
      { ...valid, approvalsReviewer: "bot" },
    ]
    expect(invalid.length).toBeGreaterThanOrEqual(6)
    for (const row of invalid) {
      expect(decodeThreadPermission(row).ok).toBe(false)
      expect(
        parsePosturePersistedRecord({
          schemaVersion: 1,
          requestedPatch: { approvalPolicy: "nope" },
          boundAskOutsidePlan: false,
          revision: 0,
        }),
      ).toBe(null)
      const section = parsePostureSection({}, { threadPermission: row, askOutsidePlan: false })
      expect(section.default).toBe(null)
    }
    const dir = await mkdtemp(join(tmpdir(), "perm-parity-"))
    const file = join(dir, "state.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        perThread: { t: { ...valid, approvalPolicy: "nope" } },
        perHost: {},
        deniedActions: {},
      }),
    )
    const store = createPermissionStore({ filePath: file })
    await store.load()
    expect(store.getThread("t")).toBeUndefined()
  })
})

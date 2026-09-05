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
})

/**
 * RFC-05 E2 — permission-store versioned posture section (durable round-trip,
 * corrupt-record drop, legacy migration, observable durability).
 *
 * Proves the additive store extension: a posture record persists + reloads
 * exactly; a corrupt/unknown-version raw record is DROPPED (rejected, not
 * accepted) while sibling grants survive; a legacy file with no posture section
 * loads unchanged; the future-thread default persists as a SEPARATE entry; and
 * `flushDurable` reports write success.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPermissionStore,
  type PermissionStore,
} from "../../../../src/permission/permission-store"
import type { PosturePersistedRecord } from "../../../../src/permission/posture/ports"
import { POSTURE_SCHEMA_VERSION } from "../../../../src/permission/posture-persistence"

let dir: string
let filePath: string

const freshStore = async (): Promise<PermissionStore> => {
  const store = createPermissionStore({ filePath, debounceMs: 0 })
  await store.load()
  return store
}

const VALID_RECORD: PosturePersistedRecord = {
  requestedPatch: {
    approvalPolicy: "never",
    approvalsReviewer: "agent",
    sandboxPolicy: { type: "workspace-write", writableRoots: ["/repo"], networkAccess: true },
    askOutsidePlan: false,
  },
  boundAskOutsidePlan: false,
  revision: 5,
  schemaVersion: POSTURE_SCHEMA_VERSION,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "posture-store-"))
  filePath = join(dir, "permission-state.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("RFC-05 E2 — store posture section", () => {
  test("a posture record round-trips across a restart", async () => {
    const store = await freshStore()
    store.setPosture("t1", VALID_RECORD)
    await store.flush()

    const store2 = await freshStore()
    const got = store2.getPosture("t1")
    expect(got).toBeDefined()
    expect(got?.revision).toBe(5)
    expect(got?.boundAskOutsidePlan).toBe(false)
    expect(got?.requestedPatch.sandboxPolicy?.type).toBe("workspace-write")
  })

  test("the future-thread default persists as a SEPARATE entry", async () => {
    const store = await freshStore()
    store.setPostureDefault({
      threadPermission: {
        approvalPolicy: "always",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      },
      askOutsidePlan: false,
    })
    await store.flush()

    const store2 = await freshStore()
    const def = store2.getPostureDefault()
    expect(def).toBeDefined()
    expect(def?.threadPermission.approvalPolicy).toBe("always")
    expect(def?.askOutsidePlan).toBe(false)
    // The default is NOT a per-thread bound record.
    expect(store2.getPosture("t1")).toBeUndefined()
  })

  test("a corrupt/unknown-version posture record is DROPPED, sibling grants survive", async () => {
    // Hand-write a state file with a valid thread GRANT plus a corrupt posture
    // record (unknown schemaVersion) and a malformed one (bad patch).
    const rawState = {
      version: 1,
      perThread: {
        keep: {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "read-only" },
        },
      },
      perHost: {},
      deniedActions: {},
      posture: {
        perThread: {
          badVersion: { ...VALID_RECORD, schemaVersion: 999 },
          malformed: {
            requestedPatch: { approvalPolicy: "bogus" },
            boundAskOutsidePlan: 3,
            revision: -1,
            schemaVersion: 1,
          },
          good: VALID_RECORD,
        },
        default: null,
      },
    }
    await writeFile(filePath, JSON.stringify(rawState), "utf8")

    const store = await freshStore()
    // Corrupt/malformed records are REJECTED (absent), the valid one loads, and
    // the sibling grant is untouched (no whole-file quarantine).
    // RED-ON-INJECTION: remove the schemaVersion/shape guard in
    // parsePosturePersistedRecord ⇒ `badVersion`/`malformed` would be accepted.
    expect(store.getPosture("badVersion")).toBeUndefined()
    expect(store.getPosture("malformed")).toBeUndefined()
    expect(store.getPosture("good")?.revision).toBe(5)
    expect(store.getThread("keep")).toBeDefined()
    expect(store.getThread("keep")?.sandboxPolicy.type).toBe("read-only")
  })

  test("a legacy file with NO posture section loads unchanged (additive migration)", async () => {
    const legacy = {
      version: 1,
      perThread: {
        t: {
          approvalPolicy: "always",
          approvalsReviewer: "agent",
          sandboxPolicy: { type: "danger-full-access" },
        },
      },
      perHost: { h: "read-only" },
      deniedActions: {},
      // no `posture` key at all
    }
    await writeFile(filePath, JSON.stringify(legacy), "utf8")

    const store = await freshStore()
    expect(store.getThread("t")?.approvalPolicy).toBe("always")
    expect(store.getHost("h")).toBe("read-only")
    expect(store.getPosture("t")).toBeUndefined()
    expect(store.getPostureDefault()).toBeUndefined()
  })

  test("flushDurable reports write success", async () => {
    const store = await freshStore()
    store.setPosture("t", VALID_RECORD)
    const outcome = await store.flushDurable()
    expect(outcome.durable).toBe(true)
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      posture?: { perThread?: Record<string, unknown> }
    }
    expect(onDisk.posture?.perThread?.t).toBeDefined()
  })
})

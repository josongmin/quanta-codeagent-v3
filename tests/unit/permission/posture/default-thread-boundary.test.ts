/**
 * RFC-05 E2 — future-thread default THREAD-COPY boundary (over the real store).
 *
 * Pins E2 RED (d): a changed default has a thread-copy boundary — new vs
 * existing threads differ, and changing the default does NOT retroactively
 * mutate a live/resumed thread. Threads created ACROSS a default change retain
 * distinct values, and those values survive a restart (fresh store from disk).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APPROVAL_LADDER } from "../../../../src/permission/approval-ladder"
import {
  createPermissionStore,
  type PermissionStore,
} from "../../../../src/permission/permission-store"
import {
  createStorePermissionDefaults,
  createStorePosturePersistence,
  createThreadPostureBinding,
} from "../../../../src/permission/posture/authority"
import type { PostureRecord, ReviewerAvailability } from "../../../../src/permission/posture/types"

const AVAILABILITY: ReviewerAvailability = { hasAutoReview: false, hasGuardianReview: false }

const DEFAULT_X: PostureRecord = {
  threadPermission: APPROVAL_LADDER.auto, // workspace-write / on-request / user
  askOutsidePlan: true,
  mode: "acceptEdits",
}
const DEFAULT_Y: PostureRecord = {
  threadPermission: APPROVAL_LADDER["guardian-approvals"], // workspace-write / on-request / agent
  askOutsidePlan: false,
  mode: "bypass",
}

let dir: string
let filePath: string

const freshStore = async (): Promise<PermissionStore> => {
  const store = createPermissionStore({ filePath, debounceMs: 0 })
  await store.load()
  return store
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "posture-default-boundary-"))
  filePath = join(dir, "permission-state.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("RFC-05 E2 — future-thread default thread-copy boundary", () => {
  test("threads created across a default change retain DISTINCT values, and survive restart", async () => {
    const store = await freshStore()
    const persistence = createStorePosturePersistence(store)
    const defaults = createStorePermissionDefaults(store)

    // Default = X, create thread A (copies X).
    await defaults.writeDefault(DEFAULT_X)
    const authA = await createThreadPostureBinding({
      threadId: "A",
      persistence,
      defaults,
      reviewerAvailability: AVAILABILITY,
    })
    expect(authA.read().effective.threadPermission.approvalsReviewer).toBe("user")
    expect(authA.read().effective.askOutsidePlan).toBe(true)

    // Change default = Y. Thread A must be UNAFFECTED (bound at creation).
    await defaults.writeDefault(DEFAULT_Y)
    expect(authA.read().effective.threadPermission.approvalsReviewer).toBe("user")
    expect(authA.read().effective.askOutsidePlan).toBe(true)

    // Create thread B AFTER the change ⇒ it copies Y.
    const authB = await createThreadPostureBinding({
      threadId: "B",
      persistence,
      defaults,
      reviewerAvailability: AVAILABILITY,
    })
    expect(authB.read().effective.threadPermission.approvalsReviewer).toBe("agent")
    expect(authB.read().effective.askOutsidePlan).toBe(false)

    // RESTART: a fresh store from the same file resumes A/B from their OWN bound
    // records — NOT the current global default.
    await store.flush()
    const store2 = await freshStore()
    const persistence2 = createStorePosturePersistence(store2)
    const defaults2 = createStorePermissionDefaults(store2)

    const resumedA = await createThreadPostureBinding({
      threadId: "A",
      persistence: persistence2,
      defaults: defaults2,
      reviewerAvailability: AVAILABILITY,
    })
    const resumedB = await createThreadPostureBinding({
      threadId: "B",
      persistence: persistence2,
      defaults: defaults2,
      reviewerAvailability: AVAILABILITY,
    })

    // RED-ON-INJECTION: make createThreadPostureBinding read the default lazily
    // at construction (skip the copy-persist) ⇒ resumedA would show the CURRENT
    // default Y (reviewer "agent") ⇒ RED here.
    expect(resumedA.read().effective.threadPermission.approvalsReviewer).toBe("user")
    expect(resumedA.read().effective.askOutsidePlan).toBe(true)
    expect(resumedB.read().effective.threadPermission.approvalsReviewer).toBe("agent")
    expect(resumedB.read().effective.askOutsidePlan).toBe(false)
    // RFC-05 E2b: the requested MODE is part of the copied binding too, and it
    // survives the restart with the thread's own value (X=acceptEdits, Y=bypass).
    expect(resumedA.read().effective.effectiveMode).toBe("acceptEdits")
    expect(resumedB.read().effective.effectiveMode).toBe("bypass")
  })

  test("an unset default reads as current behavior; a new thread copies it", async () => {
    const store = await freshStore()
    const persistence = createStorePosturePersistence(store)
    const defaults = createStorePermissionDefaults(store)

    // No default ever set ⇒ readDefault is the current-behavior record.
    const auth = await createThreadPostureBinding({
      threadId: "Z",
      persistence,
      defaults,
      reviewerAvailability: AVAILABILITY,
    })
    expect(auth.read().effective.threadPermission.sandboxPolicy.type).toBe("read-only")
    expect(auth.read().effective.askOutsidePlan).toBe(true)
    // An unset default's mode is the current-behavior default mode.
    expect(auth.read().effective.effectiveMode).toBe("default")
    expect(store.getPostureDefault()).toBeUndefined()
  })
})

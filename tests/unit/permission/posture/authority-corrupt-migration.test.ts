/**
 * RFC-05 E2 — durable posture authority: corrupt/unknown schema is REJECTED and
 * legacy/absent state migrates to CURRENT behavior.
 *
 * Pins E2 RED (c): a persisted record whose `schemaVersion` is unknown must be
 * REJECTED (fail-closed to current behavior) — never trusted and applied. Also
 * proves absent state ⇒ current behavior and a valid record round-trips.
 */

import { describe, expect, test } from "bun:test"
import { createPostureAuthority } from "../../../../src/permission/posture/authority"
import type {
  PosturePersistedRecord,
  PosturePersistencePort,
} from "../../../../src/permission/posture/ports"
import type { ReviewerAvailability } from "../../../../src/permission/posture/types"

const AVAILABILITY: ReviewerAvailability = { hasAutoReview: false, hasGuardianReview: false }

const portReturning = (rec: PosturePersistedRecord | undefined): PosturePersistencePort => ({
  readRequested: () => rec,
  writeRequested: async () => undefined,
})

describe("RFC-05 E2 — corrupt schema rejection + legacy migration", () => {
  test("an unknown schemaVersion is REJECTED — the corrupt data is NOT applied", () => {
    // A record that, IF TRUSTED, would grant danger-full-access + never-approve
    // + question-off — but its schemaVersion is unknown, so it must be rejected.
    const corrupt: PosturePersistedRecord = {
      requestedPatch: {
        approvalPolicy: "never",
        approvalsReviewer: "agent",
        sandboxPolicy: { type: "danger-full-access" },
        askOutsidePlan: false,
        mode: "bypass",
      },
      boundAskOutsidePlan: false,
      revision: 42,
      schemaVersion: 999 as unknown as PosturePersistedRecord["schemaVersion"],
    }
    const auth = createPostureAuthority({
      threadId: "c1",
      persistence: portReturning(corrupt),
      reviewerAvailability: AVAILABILITY,
    })
    const view = auth.read()

    // RED-ON-INJECTION: drop the `rec.schemaVersion !== POSTURE_SCHEMA_VERSION`
    // guard in decodePersisted ⇒ the corrupt record is trusted ⇒ approvalPolicy
    // is "never", sandbox danger-full-access, revision 42 ⇒ RED.
    expect(view.effective.threadPermission.approvalPolicy).toBe("on-request")
    expect(view.effective.threadPermission.sandboxPolicy.type).toBe("read-only")
    expect(view.effective.askOutsidePlan).toBe(true) // current behavior: unrestricted
    // The corrupt `bypass` mode is NOT trusted — migrates to current default.
    expect(view.effective.effectiveMode).toBe("default")
    expect(view.revision).toBe(0) // NOT the corrupt record's 42
  })

  test("absent persisted state migrates to current behavior", () => {
    const auth = createPostureAuthority({
      threadId: "c2",
      persistence: portReturning(undefined),
      reviewerAvailability: AVAILABILITY,
    })
    const view = auth.read()
    expect(view.revision).toBe(0)
    expect(view.effective.threadPermission.approvalPolicy).toBe("on-request")
    expect(view.effective.threadPermission.sandboxPolicy.type).toBe("read-only")
    expect(view.effective.askOutsidePlan).toBe(true)
    expect(view.requested.preset).toBe("read-only") // current base projects to read-only
  })

  test("a VALID current-version record is reconstructed exactly", () => {
    const valid: PosturePersistedRecord = {
      requestedPatch: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspace-write" },
        askOutsidePlan: false,
        mode: "acceptEdits",
      },
      boundAskOutsidePlan: false,
      revision: 3,
      schemaVersion: 1,
    }
    const auth = createPostureAuthority({
      threadId: "c3",
      persistence: portReturning(valid),
      reviewerAvailability: AVAILABILITY,
    })
    const view = auth.read()
    expect(view.revision).toBe(3)
    expect(view.effective.threadPermission.sandboxPolicy.type).toBe("workspace-write")
    expect(view.effective.askOutsidePlan).toBe(false)
    // The requested mode reconstructs from the durable patch.
    expect(view.effective.effectiveMode).toBe("acceptEdits")
    // workspace-write + on-request + user projects to the "auto" preset.
    expect(view.requested.preset).toBe("auto")
  })
})

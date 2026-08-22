/**
 * RFC-05 E2 — durable posture authority: CAS, persist-before-publish, immutable
 * view.
 *
 * Pins three of the four E2 REDs (the fourth — thread-copy default boundary —
 * is `default-thread-boundary.test.ts`):
 *   (a) concurrent writes at revision N ⇒ exactly ONE commits, the other is
 *       stale-rejected (CAS is real, not both-succeed);
 *   (b) a persistence FAILURE does NOT publish a new live view (the old
 *       revision/view stays live — persist-before-publish);
 *   the published view is IMMUTABLE.
 *
 * Each invariant carries a red-on-injection note: the exact one-line change that
 * flips the assertion RED, proving the test is non-vacuous.
 */

import { describe, expect, test } from "bun:test"
import {
  createPostureAuthority,
  type PostureMutationResult,
} from "../../../../src/permission/posture/authority"
import type {
  PosturePersistedRecord,
  PosturePersistencePort,
} from "../../../../src/permission/posture/ports"
import type { ReviewerAvailability } from "../../../../src/permission/posture/types"

const AVAILABILITY: ReviewerAvailability = { hasAutoReview: false, hasGuardianReview: false }

/** In-memory persistence port with a toggleable write failure — the seam that
 *  lets us prove persist-before-publish without a real disk. */
const makeFakePort = (
  initial?: PosturePersistedRecord,
): {
  port: PosturePersistencePort
  setFail: (fail: boolean) => void
  writes: () => number
} => {
  let stored = initial
  let fail = false
  let writes = 0
  return {
    port: {
      readRequested: () => stored,
      writeRequested: async (_threadId, record) => {
        if (fail) throw new Error("simulated disk failure")
        writes += 1
        stored = record
      },
    },
    setFail: (f) => {
      fail = f
    },
    writes: () => writes,
  }
}

const commits = (results: readonly PostureMutationResult[]): number =>
  results.filter((r) => r.ok).length

describe("RFC-05 E2 — posture authority CAS", () => {
  test("concurrent writes at revision N: exactly ONE commits, the other is stale-rejected", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "t1",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    expect(auth.read().revision).toBe(0)

    // Two writers BOTH read revision 0 and race to commit.
    const results = await Promise.all([
      auth.set({ approvalPolicy: "never" }, 0),
      auth.set({ approvalsReviewer: "agent" }, 0),
    ])

    // RED-ON-INJECTION: delete the `expectedRevision !== current.revision`
    // stale check in authority.set ⇒ BOTH commit ⇒ this is 2 and revision is 2.
    expect(commits(results)).toBe(1)
    expect(auth.read().revision).toBe(1)

    const loser = results.find((r) => !r.ok)
    expect(loser).toBeDefined()
    if (loser && !loser.ok) {
      expect(loser.rejection.kind).toBe("stale_revision")
      if (loser.rejection.kind === "stale_revision") {
        expect(loser.rejection.expected).toBe(0)
        expect(loser.rejection.actual).toBe(1)
      }
    }
    // Exactly one durable write landed (the loser never persisted).
    expect(fake.writes()).toBe(1)
  })

  test("a stale expectedRevision is rejected without persisting or publishing", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "t2",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    const result = await auth.set({ approvalPolicy: "always" }, 7 /* wrong */)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.kind).toBe("stale_revision")
    expect(auth.read().revision).toBe(0)
    expect(fake.writes()).toBe(0)
  })

  test("a successful set advances the revision and effective view, and reload reconstructs it", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "t3",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    const before = auth.read()
    expect(before.effective.threadPermission.approvalPolicy).toBe("on-request")

    const result = await auth.set(
      { approvalPolicy: "never", sandboxPolicy: { type: "danger-full-access" } },
      0,
    )
    expect(result.ok).toBe(true)
    const after = auth.read()
    expect(after.revision).toBe(1)
    expect(after.effective.threadPermission.approvalPolicy).toBe("never")
    expect(after.effective.threadPermission.sandboxPolicy.type).toBe("danger-full-access")

    // A fresh authority reading the SAME persisted record reconstructs the
    // identical effective view + revision (durable, not event-replayed).
    const reloaded = createPostureAuthority({
      threadId: "t3",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    expect(reloaded.read().revision).toBe(1)
    expect(reloaded.read().effective.threadPermission.approvalPolicy).toBe("never")
    expect(reloaded.read().effective.threadPermission.sandboxPolicy.type).toBe("danger-full-access")
  })

  test("persistence FAILURE does not publish a new live view (persist-before-publish)", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "t4",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    const original = auth.read()
    expect(original.revision).toBe(0)
    expect(original.effective.threadPermission.approvalPolicy).toBe("on-request")

    fake.setFail(true)
    const result = await auth.set(
      { approvalPolicy: "never", sandboxPolicy: { type: "danger-full-access" } },
      0,
    )

    // The write is refused as a TYPED persist failure...
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.kind).toBe("persist_failed")

    // ...and the OLD view is STILL live: revision + effective unchanged.
    // RED-ON-INJECTION: move the `current = ...; view = ...` swap ABOVE the
    // `await writeRequested` (publish-before-persist) ⇒ revision becomes 1 and
    // approvalPolicy becomes "never" here ⇒ RED.
    const still = auth.read()
    expect(still.revision).toBe(0)
    expect(still.effective.threadPermission.approvalPolicy).toBe("on-request")
    expect(still.effective.threadPermission.sandboxPolicy.type).toBe("read-only")
    expect(fake.writes()).toBe(0)

    // And recovery: once persistence works again, the same expected revision (0,
    // unchanged by the failure) commits.
    fake.setFail(false)
    const retry = await auth.set({ approvalPolicy: "never" }, 0)
    expect(retry.ok).toBe(true)
    expect(auth.read().revision).toBe(1)
  })

  test("a set that carries `mode` advances the effective mode, and reload reconstructs it", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "tm",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    // Legacy-absent ⇒ current default mode.
    expect(auth.read().effective.effectiveMode).toBe("default")

    const result = await auth.set({ mode: "bypass" }, 0)
    expect(result.ok).toBe(true)
    expect(auth.read().effective.effectiveMode).toBe("bypass")

    // A fresh authority over the SAME persisted record reconstructs the mode
    // (it round-trips through the durable requestedPatch, not an event replay).
    const reloaded = createPostureAuthority({
      threadId: "tm",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    expect(reloaded.read().effective.effectiveMode).toBe("bypass")
  })

  test("a managed mode clamp forces the effective mode over the persisted requested mode", async () => {
    const fake = makeFakePort()
    // Persist a requested mode of `bypass`...
    const seeded = createPostureAuthority({
      threadId: "tc",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    await seeded.set({ mode: "bypass" }, 0)

    // ...then reload WITH a managed clamp to `default`: the clamp wins.
    const clamped = createPostureAuthority({
      threadId: "tc",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
      managedMode: "default",
    })
    // RED-ON-INJECTION: drop `managedMode` from buildView ⇒ this is "bypass" ⇒ RED.
    expect(clamped.read().effective.effectiveMode).toBe("default")
    // Paired control: no clamp ⇒ the requested `bypass` stands.
    const unclamped = createPostureAuthority({
      threadId: "tc",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    expect(unclamped.read().effective.effectiveMode).toBe("bypass")
  })

  test("the published view is immutable (frozen top-level and lock array)", async () => {
    const fake = makeFakePort()
    const auth = createPostureAuthority({
      threadId: "t5",
      persistence: fake.port,
      reviewerAvailability: AVAILABILITY,
    })
    const view = auth.read()
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.locks)).toBe(true)
    // DEEP-frozen: a nested field (built fresh by applyPatch, not from the frozen
    // ladder) is also immutable.
    expect(Object.isFrozen(view.effective)).toBe(true)
    expect(Object.isFrozen(view.effective.threadPermission)).toBe(true)
    expect(Object.isFrozen(view.requested.patch)).toBe(true)
    expect(() => {
      ;(view as { revision: number }).revision = 99
    }).toThrow()
    expect(() => {
      ;(view.effective.threadPermission as { approvalPolicy: string }).approvalPolicy = "never"
    }).toThrow()
  })
})

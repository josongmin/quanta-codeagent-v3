import { describe, expect, test } from "bun:test"
import { prepareObjectiveSnapshotForAttach } from "@/host/runtime/objective-store-wire"
import {
  asObjectiveAuthority,
  createObjectiveStore,
  evaluateGoalWakeFire,
  type ProgressReceipt,
} from "@/objective"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"

const receipt = (objectiveId: string, revision: number): ProgressReceipt => ({
  objectiveId,
  attemptKey: `attempt-${objectiveId}`,
  objectiveRevisionBefore: revision,
  objectiveRevisionAfter: revision,
  turnOutcome: "error",
  criterionTransitions: [],
  verifierReceiptRefs: [],
  remainingCriterionIds: [],
  recordedAt: 1,
})

describe("objective explicit attach replacement", () => {
  test("replaces identity, evidence, revision, and attach generation", () => {
    const live = asObjectiveAuthority(createObjectiveStore())
    live.create("live", { goal: "A" })
    const a = live.readDomain("live")
    expect(
      live.recordProgressReceipt("live", receipt(a.state?.objective.objectiveId ?? "", a.revision)),
    ).toBe(true)

    const persisted = asObjectiveAuthority(createObjectiveStore())
    persisted.create("disk-B", { goal: "B" })
    const b = persisted.readDomain("disk-B")
    const result = live.replaceDomainForAttach({ liveThreadId: "live", persistedDomain: b })

    expect(result.ok).toBe(true)
    const attached = live.readDomain("live")
    expect(attached.state?.objective.objectiveId).toBe(b.state?.objective.objectiveId)
    expect(attached.state?.objective.goal).toBe("B")
    expect(attached.revision).toBeGreaterThan(a.revision)
    expect(attached.attachGeneration).toBe(1)
    expect(attached.progressReceipts).toEqual([])
  })

  test("an attached thread with no objective clears all live evidence", () => {
    const live = asObjectiveAuthority(createObjectiveStore())
    live.create("live", { goal: "A" })
    const before = live.readDomain("live")
    live.recordProgressReceipt(
      "live",
      receipt(before.state?.objective.objectiveId ?? "", before.revision),
    )
    expect(live.replaceDomainForAttach({ liveThreadId: "live", persistedDomain: null }).ok).toBe(
      true,
    )
    const after = live.readDomain("live")
    expect(after.state).toBeNull()
    expect(after.progressReceipts).toEqual([])
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  test("invalid input is fail-closed", () => {
    const live = asObjectiveAuthority(createObjectiveStore())
    live.create("live", { goal: "A" })
    const before = live.readDomain("live")
    expect(
      live.replaceDomainForAttach({
        liveThreadId: "live",
        persistedDomain: { threadId: "bad", revision: 2, state: null },
      }),
    ).toEqual({ ok: false, reason: "invalid" })
    expect(live.readDomain("live")).toEqual(before)
  })

  test("a multi-domain persisted snapshot is rejected before live mutation", () => {
    const live = createObjectiveStore()
    live.create("live", { goal: "A" })
    const before = asObjectiveAuthority(live).readDomain("live")
    const disk = createObjectiveStore()
    disk.create("one", { goal: "one" })
    disk.create("two", { goal: "two" })
    expect(prepareObjectiveSnapshotForAttach(live, encodeObjectiveSnapshot(disk), "live")).toEqual({
      ok: false,
      reason: "invalid-objective-snapshot",
    })
    expect(asObjectiveAuthority(live).readDomain("live")).toEqual(before)
  })

  test("GOAL-07 epoch fence — the detached previous thread's attach generation advances, so a stale wake armed before the attach is refused even after that thread is re-created", () => {
    const live = asObjectiveAuthority(createObjectiveStore())
    live.create("old", { goal: "A", successCriteria: ["c"] })
    const before = live.readDomain("old")
    const stale = {
      threadId: "old",
      objectiveId: before.state?.objective.objectiveId ?? "",
      objectiveRevision: before.revision,
      attachGeneration: before.attachGeneration ?? 0,
      checkpointOrdinal: 0,
      activityEpoch: 0,
      attemptKey: "stale",
    }
    const persisted = asObjectiveAuthority(createObjectiveStore())
    persisted.create("disk-B", { goal: "B", successCriteria: ["c"] })
    const result = live.replaceDomainForAttach({
      liveThreadId: "live",
      previousLiveThreadId: "old",
      persistedDomain: persisted.readDomain("disk-B"),
    })
    expect(result.ok).toBe(true)
    // the previous thread is cleared AND its generation moved
    expect(live.readDomain("old").state).toBeNull()
    expect(live.readDomain("old").attachGeneration).toBe(1)
    // re-create a goal on the old thread: the stale attempt still cannot fire
    live.create("old", { goal: "A again", successCriteria: ["c"] })
    const current = live.readDomain("old")
    expect(current.attachGeneration).toBe(1)
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected: {
          ...stale,
          objectiveRevision: current.revision,
          objectiveId: current.state?.objective.objectiveId ?? "",
        },
        current,
        activityEpoch: 0,
        stillQuiescent: true,
      }),
    ).toEqual({ arm: false, skipReason: "revision-changed" })
  })
})

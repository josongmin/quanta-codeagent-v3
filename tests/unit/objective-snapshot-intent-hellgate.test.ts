/**
 * HELLGATE [ADR-0394] — snapshot persists EXPLICIT INTENT, not DERIVED status.
 *
 * Regression guard for the SERDE conflation bug: an objective whose status is
 * auto-derived "completed" (all criteria met) but whose underlying explicit
 * intent is still "active" must survive a snapshot round-trip WITHOUT the
 * explicit intent being silently upgraded to "completed". If it were upgraded,
 * unmarking a criterion after restore would no longer revert to "active" — the
 * derived-vs-explicit distinction pinned by objective-hellgate.test.ts:185
 * would be lost across persistence.
 *
 * Anti-theater: against the UNFIXED store (which restored
 * `explicitStatus = rec.status === "completed" ? "completed" : "active"`), the
 * "unmark reverts to active after restore" assertion FAILS — restore stamps
 * explicitStatus="completed", so unmarking yields "completed", not "active".
 */
import { describe, expect, test } from "bun:test"
import type { ObjectivePort, ObjectiveSnapshot } from "@/agent/objective"
import { createObjectiveStore } from "@/agent/objective"

const TID = "thread-intent"
const freshStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

describe("HELLGATE [ADR-0394] — snapshot persists intent, not derivation", () => {
  test("auto-derived 'completed' round-trips, then unmark reverts to 'active'", () => {
    const store = freshStore(7)
    const obj = store.set(TID, { goal: "g", successCriteria: ["x"] })
    const id = obj.successCriteria[0]?.id ?? ""

    // Auto-derive completion (explicit intent is still the default "active").
    expect(store.markCriterion(TID, id, true)?.status).toBe("completed")

    // Persist + restore into a fresh store.
    const snap = store.toSnapshot()
    const restored = freshStore(99)
    restored.fromSnapshot(snap)

    // Restored objective still reports the DERIVED completion.
    expect(restored.get(TID)?.status).toBe("completed")

    // THE BUG: unmarking the criterion must revert to "active" because the
    // completion was auto-derived, NOT an explicit updateStatus("completed").
    const cid = restored.get(TID)?.successCriteria[0]?.id ?? ""
    expect(restored.markCriterion(TID, cid, false)?.status).toBe("active")
  })

  test("EXPLICIT 'completed' (no criteria) round-trips and STAYS completed", () => {
    // The complement: a genuine explicit completion must NOT be downgraded.
    const store = freshStore(7)
    store.set(TID, { goal: "g" })
    expect(store.updateStatus(TID, "completed")?.status).toBe("completed")

    const restored = freshStore(99)
    restored.fromSnapshot(store.toSnapshot())
    // Zero criteria ⇒ no auto-derivation; the explicit intent must survive.
    expect(restored.get(TID)?.status).toBe("completed")
  })

  test("explicit intent survives even while a blocker masks it as 'blocked'", () => {
    const store = freshStore(7)
    store.set(TID, { goal: "g" })
    store.updateStatus(TID, "completed")
    store.addBlocker(TID, { reason: "wait", waitingOn: "user" })
    // Derived view is "blocked" while the blocker stands.
    const snapped = store.toSnapshot()
    expect(store.get(TID)?.status).toBe("blocked")

    const restored = freshStore(99)
    restored.fromSnapshot(snapped)
    expect(restored.get(TID)?.status).toBe("blocked")

    // Clearing the blocker must expose the PERSISTED explicit "completed",
    // not the masked "blocked" or a defaulted "active".
    const bid = restored.get(TID)?.blockers[0]?.id ?? ""
    expect(restored.clearBlocker(TID, bid)?.status).toBe("completed")
  })

  test("legacy snapshot WITHOUT explicitStatus does not fabricate explicit completion", () => {
    // A hostile / pre-fix payload carries only the derived status. The restore
    // must NOT infer explicit intent from it: derived "completed" with met
    // criteria stays completed, but unmarking still reverts to active.
    const legacy = {
      objectives: [
        {
          threadId: TID,
          goal: "g",
          successCriteria: [{ id: "c1", text: "x", met: true }],
          status: "completed", // derived only — no explicitStatus field
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as unknown as ObjectiveSnapshot

    const store = freshStore(99)
    store.fromSnapshot(legacy)
    expect(store.get(TID)?.status).toBe("completed")
    expect(store.markCriterion(TID, "c1", false)?.status).toBe("active")
  })

  test("snapshot stays byte-stable through JSON with the explicit field present", () => {
    const store = freshStore(1)
    const obj = store.set(TID, { goal: "g", successCriteria: ["a"] })
    store.markCriterion(TID, obj.successCriteria[0]?.id ?? "", true)
    const snap = store.toSnapshot()
    const round = JSON.parse(JSON.stringify(snap)) as ObjectiveSnapshot
    const restored = freshStore(2)
    restored.fromSnapshot(round)
    expect(JSON.stringify(restored.toSnapshot())).toBe(JSON.stringify(snap))
  })
})

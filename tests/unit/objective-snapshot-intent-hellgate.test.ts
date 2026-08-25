/**
 * HELLGATE [ADR-0394] — snapshot persists EXPLICIT INTENT, not DERIVED status.
 *
 * Regression guard for the SERDE conflation bug: an objective whose status is
 * auto-derived "completed" (all criteria met) but whose underlying explicit
 * intent is still "active" must survive a snapshot round-trip WITHOUT the
 * explicit intent being silently upgraded to "completed". If it were upgraded,
 * unmarking a criterion after restore would no longer revert to "active" — the
 * derived-vs-explicit distinction pinned by objective-hellgate.test.ts
 * ("unmarking a criterion reverts 'completed' back to active") would be lost
 * across persistence.
 *
 * Anti-theater: against the UNFIXED store (which restored
 * `explicitStatus = rec.status === "completed" ? "completed" : "active"`), the
 * "unmark reverts to active after restore" assertion FAILS — restore stamps
 * explicitStatus="completed", so unmarking yields "completed", not "active".
 *
 * GOAL-01: the explicit intent is now ONLY `active | paused`. A persisted
 * `explicitStatus: "completed"` (legacy) is DISCARDED on restore and completion
 * re-derives from met criteria. The "explicit intent survives masking" proof
 * is kept, using `paused` — the one explicit non-default intent that remains.
 */
import { describe, expect, test } from "bun:test"
import type { ExplicitObjectiveStatus, ObjectivePort, ObjectiveSnapshot } from "@/objective"
import { createObjectiveStore, LEGACY_OBJECTIVE_ID_PREFIX } from "@/objective"
import { seedObjective } from "./objective/v2-helpers"

const TID = "thread-intent"
const freshStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

/** A pre-GOAL-01 snapshot record: no objectiveId / createdBy, and whatever
 *  `explicitStatus` the old store wrote. */
const legacyRecord = (over: Record<string, unknown>): ObjectiveSnapshot =>
  ({
    objectives: [
      {
        threadId: TID,
        goal: "g",
        successCriteria: [],
        status: "active",
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: [],
        nextActions: [],
        createdAt: 1,
        updatedAt: 1,
        ...over,
      },
    ],
  }) as unknown as ObjectiveSnapshot

describe("HELLGATE [ADR-0394] — snapshot persists intent, not derivation", () => {
  test("auto-derived 'completed' round-trips, then unmark reverts to 'active'", () => {
    const store = freshStore(7)
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
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
    // completion was auto-derived, NOT an explicit completion intent.
    const cid = restored.get(TID)?.successCriteria[0]?.id ?? ""
    expect(restored.markCriterion(TID, cid, false)?.status).toBe("active")
  })

  // GOAL-01 (REVERSED): this test used to prove that an EXPLICIT "completed"
  // with zero criteria survives a round-trip. There is no explicit completion
  // any more — a legacy snapshot carrying `explicitStatus: "completed"` is
  // migrated to `active`, and with zero criteria nothing re-derives it.
  test("a legacy EXPLICIT 'completed' (no criteria) is DISCARDED on restore — status re-derives to 'active'", () => {
    const restored = freshStore(99)
    restored.fromSnapshot(legacyRecord({ status: "completed", explicitStatus: "completed" }))
    const got = restored.get(TID)
    expect(got).not.toBeNull()
    expect(got?.status).toBe("active")
    // …and the migrated generation is tagged as such, with a deterministic id.
    expect(got?.migrationSource).toBe("legacy-v1")
    expect(got?.objectiveId.startsWith(LEGACY_OBJECTIVE_ID_PREFIX)).toBe(true)
    expect(got?.createdBy).toBe("system")
    // A re-encode never resurrects the legacy intent.
    const again = freshStore(100)
    again.fromSnapshot(restored.toSnapshot())
    expect(again.get(TID)?.status).toBe("active")
  })

  test("a hostile explicit 'completed' intent is refused at the live surface too", () => {
    const store = freshStore(7)
    seedObjective(store, TID, { goal: "g" })
    // GOAL-01: the type is `active | paused`; a forged value must not leak
    // through the runtime dispatch either.
    const forged = "completed" as unknown as ExplicitObjectiveStatus
    expect(() => store.setExplicitStatus(TID, forged)).not.toThrow()
    expect(store.get(TID)?.status).toBe("active")
    const restored = freshStore(99)
    restored.fromSnapshot(store.toSnapshot())
    expect(restored.get(TID)?.status).toBe("active")
  })

  // GOAL-01: the protective intent (a masked explicit value must survive
  // persistence verbatim) is kept, exercised with `paused` — the explicit
  // non-default intent that still exists.
  test("explicit intent survives even while a blocker masks it as 'blocked'", () => {
    const store = freshStore(7)
    seedObjective(store, TID, { goal: "g" })
    expect(store.setExplicitStatus(TID, "paused")?.status).toBe("paused")
    store.addBlocker(TID, { reason: "wait", waitingOn: "user" })
    // Derived view is "blocked" while the blocker stands.
    const snapped = store.toSnapshot()
    expect(store.get(TID)?.status).toBe("blocked")

    const restored = freshStore(99)
    restored.fromSnapshot(snapped)
    expect(restored.get(TID)?.status).toBe("blocked")

    // Clearing the blocker must expose the PERSISTED explicit "paused",
    // not the masked "blocked" or a defaulted "active".
    const bid = restored.get(TID)?.blockers[0]?.id ?? ""
    expect(restored.clearBlocker(TID, bid)?.status).toBe("paused")
  })

  test("a legacy explicit 'completed' masked by a blocker re-derives to 'active' once unblocked", () => {
    // GOAL-01 (REVERSED complement): the old store would have exposed the
    // persisted "completed" after the blocker cleared. Now the legacy intent is
    // dropped on restore, so clearing the blocker yields "active".
    const restored = freshStore(99)
    restored.fromSnapshot(
      legacyRecord({
        status: "blocked",
        explicitStatus: "completed",
        blockers: [{ id: "b1", reason: "wait", waitingOn: "user", since: 1 }],
      }),
    )
    expect(restored.get(TID)?.status).toBe("blocked")
    expect(restored.clearBlocker(TID, "b1")?.status).toBe("active")
  })

  test("legacy snapshot WITHOUT explicitStatus does not fabricate explicit completion", () => {
    // A hostile / pre-fix payload carries only the derived status. The restore
    // must NOT infer explicit intent from it.
    // GOAL-02 (REVERSED): a bare `met:true` with NO completion receipt used to
    // re-derive "completed". Completion is now a projection of TRUSTED evidence
    // only — the flag survives but the persisted "completed" is NOT honored.
    const legacy = legacyRecord({
      successCriteria: [{ id: "c1", text: "x", met: true }],
      status: "completed", // derived only — no explicitStatus field
    })

    const store = freshStore(99)
    store.fromSnapshot(legacy)
    expect(store.get(TID)?.successCriteria[0]?.met).toBe(true)
    expect(store.get(TID)?.status).toBe("active")
    expect(store.markCriterion(TID, "c1", false)?.status).toBe("active")
    expect(store.get(TID)?.successCriteria[0]?.met).toBe(false)
  })

  // GOAL-02: the paired control for the case above — the SAME legacy record with
  // a manual receipt. A `model`-attested receipt (a v1 self-mark) is INERT for
  // completion; a `user`-attested one re-derives "completed", and unmarking
  // still reverts to "active" (derived, never explicit).
  test("a legacy MODEL-attested manual receipt is inert; a USER-attested one re-derives 'completed'", () => {
    const withActor = (actor: string): ObjectiveSnapshot =>
      legacyRecord({
        successCriteria: [
          {
            id: "c1",
            text: "x",
            met: true,
            // pre-GOAL-01 receipt: no objectiveId — the migration binds it.
            completion: { source: "manual", actor, objectiveRevision: 1, verifiedAt: 1 },
          },
        ],
        status: "completed",
      })

    const untrusted = freshStore(99)
    untrusted.fromSnapshot(withActor("model"))
    const c = untrusted.get(TID)?.successCriteria[0]
    expect(c?.met).toBe(true)
    expect(c?.completion?.source === "manual" ? c.completion.actor : "").toBe("model")
    expect(c?.completion?.objectiveId).toBe(untrusted.get(TID)?.objectiveId ?? "")
    expect(untrusted.get(TID)?.status).toBe("active")

    const trusted = freshStore(99)
    trusted.fromSnapshot(withActor("user"))
    expect(trusted.get(TID)?.status).toBe("completed")
    expect(trusted.markCriterion(TID, "c1", false)?.status).toBe("active")
  })

  test("snapshot stays byte-stable through JSON with the explicit field present", () => {
    const store = freshStore(1)
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["a"] })
    store.markCriterion(TID, obj.successCriteria[0]?.id ?? "", true)
    store.setExplicitStatus(TID, "paused")
    const snap = store.toSnapshot()
    const round = JSON.parse(JSON.stringify(snap)) as ObjectiveSnapshot
    const restored = freshStore(2)
    restored.fromSnapshot(round)
    expect(JSON.stringify(restored.toSnapshot())).toBe(JSON.stringify(snap))
  })
})

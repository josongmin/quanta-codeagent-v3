/**
 * GOAL-01 hellgate — objective domain v2.
 *
 * One authority is the only writer; every objective carries an authority-issued
 * `objectiveId`; `create`/`replace`/`clear` are distinct mutations; `completed`
 * is never an explicit intent; a cleared thread leaves a revision TOMBSTONE that
 * rejects stale pre-clear commands; usage is settled by the host through
 * `settleAttempt` (never a model-facing `recordUsage`).
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  MAX_GOAL_CHARS,
  OBJECTIVE_OPERATION_KINDS,
  type ObjectiveAttemptSettlement,
  type ObjectiveAuthority,
  type ObjectiveMutation,
} from "@/objective"

const authority = (idFactory?: () => string): ObjectiveAuthority =>
  createObjectiveAuthority({ now: () => 1_000, ...(idFactory ? { idFactory } : {}) })

const run = (
  auth: ObjectiveAuthority,
  threadId: string,
  mutation: ObjectiveMutation,
  actor: "user" | "system" | "model" | "verifier" | "continuation" = "user",
) => auth.commit(auth.prepare({ threadId, actor, mutation }), { admitted: true })

const create = (auth: ObjectiveAuthority, threadId = "t", criteria: readonly string[] = []) =>
  run(auth, threadId, { kind: "create", definition: { goal: "ship", successCriteria: criteria } })

const settlement = (
  auth: ObjectiveAuthority,
  threadId: string,
  over: Partial<ObjectiveAttemptSettlement> = {},
): ObjectiveAttemptSettlement => {
  const dom = auth.readDomain(threadId)
  return {
    objectiveId: dom.state?.objective.objectiveId ?? "missing",
    attemptId: "attempt-1",
    startedRevision: dom.revision,
    tokensUsed: 10,
    turnsUsed: 1,
    outcome: "completed",
    executionMode: "foreground",
    criterionIdsBefore: [],
    verifierReceiptIdsBefore: [],
    recordedAt: 5,
    ...over,
  }
}

describe("GOAL-01 — create / replace / clear", () => {
  test("create issues an authority-minted objectiveId and createdBy from the bound actor", () => {
    let n = 0
    const auth = authority(() => `id-${++n}`)
    const res = create(auth)
    expect(res.ok).toBe(true)
    const o = auth.get("t")
    expect(o?.objectiveId).toBe("id-1")
    expect(o?.createdBy).toBe("user")
    expect(o?.migrationSource).toBeUndefined()
    expect(o?.status).toBe("active")
  })

  test("duplicate create -> objective-exists; replace without objective -> objective-missing", () => {
    const auth = authority()
    expect(create(auth).ok).toBe(true)
    const dup = create(auth)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe("objective-exists")
    const missing = run(auth, "other", { kind: "replace", definition: { goal: "x" } })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe("objective-missing")
  })

  test("replace changes objectiveId, clears every evidence family, bumps revision once", () => {
    let n = 0
    const auth = authority(() => `id-${++n}`)
    create(auth, "t", ["a"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    auth.markCriterion("t", cid, true)
    auth.addBlocker("t", { reason: "r", waitingOn: "user" })
    auth.setNextActions("t", ["next"])
    expect(
      run(auth, "t", { kind: "settleAttempt", settlement: settlement(auth, "t") }, "system").ok,
    ).toBe(true)
    expect(auth.readDomain("t").progressReceipts?.length).toBe(1)
    const before = auth.readDomain("t").revision
    const res = run(auth, "t", {
      kind: "replace",
      definition: { goal: "new", successCriteria: ["b"] },
    })
    expect(res.ok).toBe(true)
    const dom = auth.readDomain("t")
    expect(dom.revision).toBe(before + 1)
    const o = dom.state?.objective
    expect(o?.objectiveId).toBe("id-2")
    expect(o?.goal).toBe("new")
    expect(o?.successCriteria.map((c) => c.met)).toEqual([false])
    expect(o?.blockers).toEqual([])
    expect(o?.nextActions).toEqual([])
    expect(o?.budget.tokensUsed).toBe(0)
    expect(dom.progressReceipts).toEqual([])
  })

  test("clear deletes state and progress, and the revision stays monotonic (tombstone)", () => {
    const auth = authority()
    create(auth)
    run(auth, "t", { kind: "settleAttempt", settlement: settlement(auth, "t") }, "system")
    const before = auth.readDomain("t").revision
    const cleared = run(auth, "t", { kind: "clear" })
    expect(cleared.ok).toBe(true)
    const dom = auth.readDomain("t")
    expect(dom.state).toBeNull()
    expect(dom.progressReceipts).toEqual([])
    expect(dom.revision).toBe(before + 1)
    expect(auth.get("t")).toBeNull()
    // A command prepared BEFORE the clear is stale against the tombstone.
    const stale = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "user",
        mutation: { kind: "create", definition: { goal: "again" } },
        expectedRevision: before,
      }),
      { admitted: true },
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe("stale")
    // A fresh create after clear starts from the tombstone revision, never 0/1.
    const again = create(auth)
    expect(again.ok).toBe(true)
    expect(auth.readDomain("t").revision).toBe(before + 2)
  })

  test("goal length: exactly MAX_GOAL_CHARS passes, one more is rejected at the domain", () => {
    const auth = authority()
    expect(MAX_GOAL_CHARS).toBe(4000)
    expect(run(auth, "ok", { kind: "create", definition: { goal: "g".repeat(4000) } }).ok).toBe(
      true,
    )
    const tooLong = run(auth, "bad", { kind: "create", definition: { goal: "g".repeat(4001) } })
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toBe("goal-too-long")
    expect(auth.get("bad")).toBeNull()
  })
})

describe("GOAL-01 — explicit status is only active|paused", () => {
  test("setExplicitStatus(paused/active) round-trips; a removed kind fails normalization", () => {
    const auth = authority()
    create(auth)
    expect(run(auth, "t", { kind: "setExplicitStatus", status: "paused" }).ok).toBe(true)
    expect(auth.get("t")?.status).toBe("paused")
    expect(run(auth, "t", { kind: "setExplicitStatus", status: "active" }).ok).toBe(true)
    expect(auth.get("t")?.status).toBe("active")
    const forged = run(auth, "t", {
      kind: "setExplicitStatus",
      status: "completed" as unknown as "paused",
    })
    expect(forged.ok).toBe(false)
    expect(auth.get("t")?.status).toBe("active")
    for (const gone of ["set", "updateStatus", "recordUsage"]) {
      expect((OBJECTIVE_OPERATION_KINDS as readonly string[]).includes(gone)).toBe(false)
      const res = run(auth, "t", { kind: gone } as unknown as ObjectiveMutation)
      expect(res.ok).toBe(false)
    }
  })

  test("completed is derived from evidence only — a manual met flips it, unmark reverts", () => {
    const auth = authority()
    create(auth, "t", ["only"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    expect(run(auth, "t", { kind: "markCriterion", criterionId: cid, met: true }).ok).toBe(true)
    expect(auth.get("t")?.status).toBe("completed")
    expect(auth.readDomain("t").state?.explicitStatus).toBe("active")
    expect(run(auth, "t", { kind: "markCriterion", criterionId: cid, met: false }).ok).toBe(true)
    expect(auth.get("t")?.status).toBe("active")
  })
})

describe("GOAL-01 — evidence is bound to the objective generation", () => {
  test("a progress receipt carrying an old objectiveId is rejected without a revision change", () => {
    let n = 0
    const auth = authority(() => `id-${++n}`)
    create(auth)
    run(auth, "t", { kind: "replace", definition: { goal: "v2" } })
    const rev = auth.readDomain("t").revision
    const accepted = auth.recordProgressReceipt("t", {
      objectiveId: "id-1",
      attemptKey: "old",
      objectiveRevisionBefore: rev,
      objectiveRevisionAfter: rev,
      turnOutcome: "completed",
      criterionTransitions: [],
      verifierReceiptRefs: [],
      remainingCriterionIds: [],
      recordedAt: 1,
    })
    expect(accepted).toBe(false)
    expect(auth.readDomain("t").revision).toBe(rev)
    expect(auth.readDomain("t").progressReceipts).toEqual([])
  })

  test("settleAttempt with a stale objectiveId or a replayed attemptId is rejected", () => {
    let n = 0
    const auth = authority(() => `id-${++n}`)
    create(auth)
    const first = run(
      auth,
      "t",
      { kind: "settleAttempt", settlement: settlement(auth, "t") },
      "system",
    )
    expect(first.ok).toBe(true)
    expect(auth.get("t")?.budget.tokensUsed).toBe(10)
    expect(auth.get("t")?.budget.turnsUsed).toBe(1)
    const replay = run(
      auth,
      "t",
      { kind: "settleAttempt", settlement: settlement(auth, "t") },
      "system",
    )
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.reason).toBe("attempt-replayed")
    expect(auth.get("t")?.budget.tokensUsed).toBe(10)
    run(auth, "t", { kind: "replace", definition: { goal: "v2" } })
    const stale = run(
      auth,
      "t",
      {
        kind: "settleAttempt",
        settlement: settlement(auth, "t", { objectiveId: "id-1", attemptId: "a2" }),
      },
      "system",
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe("objective-mismatch")
    expect(auth.get("t")?.budget.tokensUsed).toBe(0)
  })

  test("settleAttempt records only the delta of criterion transitions and verifier receipts", () => {
    const auth = authority()
    create(auth, "t", ["a", "b"])
    const [a, b] = auth.get("t")?.successCriteria.map((c) => c.id) ?? []
    auth.markCriterion("t", a ?? "", true)
    const before = settlement(auth, "t", { criterionIdsBefore: [a ?? ""] })
    auth.markCriterion("t", b ?? "", true)
    expect(run(auth, "t", { kind: "settleAttempt", settlement: before }, "system").ok).toBe(true)
    const receipt = auth.readDomain("t").progressReceipts?.[0]
    expect(receipt?.criterionTransitions).toEqual([b ?? ""])
    expect(receipt?.remainingCriterionIds).toEqual([])
    expect(receipt?.attemptKey).toBe("attempt-1")
    expect(receipt?.objectiveId).toBe(auth.get("t")?.objectiveId)
    expect(receipt?.recordedAt).toBe(5)
  })

  test("a model/user actor cannot settle an attempt (system-fixed)", () => {
    const auth = authority()
    create(auth)
    for (const actor of ["model", "user", "continuation", "verifier"] as const) {
      const res = run(
        auth,
        "t",
        { kind: "settleAttempt", settlement: settlement(auth, "t") },
        actor,
      )
      expect(res.ok).toBe(false)
    }
    expect(auth.get("t")?.budget.turnsUsed).toBe(0)
  })
})

describe("GOAL-01 — whole-store restore clears stale progress", () => {
  test("fromSnapshot drops the previous thread's progress receipts", () => {
    const auth = authority()
    create(auth, "x")
    run(auth, "x", { kind: "settleAttempt", settlement: settlement(auth, "x") }, "system")
    expect(auth.readDomain("x").progressReceipts?.length).toBe(1)
    const other = authority()
    create(other, "y")
    auth.fromSnapshot(other.toSnapshot())
    expect(auth.readDomain("x").progressReceipts).toEqual([])
    expect(auth.get("x")).toBeNull()
    expect(auth.get("y")).not.toBeNull()
  })
})

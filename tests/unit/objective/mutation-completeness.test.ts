/**
 * RFC-03 C1 hellgate — mutation-completeness ratchet.
 *
 * The authority is the ONLY writer of the objective domain. This ratchet pins
 * two properties that make "route every mutation through the authority" durable:
 *
 *   1. CLOSED UNION FLOOR — `OBJECTIVE_OPERATION_KINDS` is the exhaustive,
 *      two-way-guarded set of mutation kinds (adding a kind to the union without
 *      listing it here fails compile; the runtime floor is non-zero). The
 *      authority's dispatch table has EXACTLY these keys — no unrouted operation.
 *
 *   2. LIVE-CALL RED — every operation kind, when driven through the authority,
 *      produces a distinct, observable effect. Deleting a live authority handler
 *      makes the corresponding assertion RED (the effect vanishes). This is the
 *      "deleting any live authority call makes the completeness test RED" rail.
 *
 * Together they forbid a silent regression to a direct store call: a mutation
 * that stops flowing through the authority loses its effect here.
 *
 * GOAL-01: the union is `create | replace | clear | setExplicitStatus |
 * addBlocker | clearBlocker | setNextActions | markCriterion |
 * markCriterionVerified | amendBudget | settleAttempt | markUsageLimited |
 * restore` (`set` / `updateStatus` / `recordUsage` are gone).
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  isObjectiveOperationKind,
  OBJECTIVE_OPERATION_KINDS,
  objectiveMutationDispatchKeys,
} from "@/objective"
import { nextAttemptId } from "./v2-helpers"

describe("C1 — closed operation union floor", () => {
  test("the operation-kind floor is non-zero and unique", () => {
    expect(OBJECTIVE_OPERATION_KINDS.length).toBeGreaterThanOrEqual(13)
    expect(new Set(OBJECTIVE_OPERATION_KINDS).size).toBe(OBJECTIVE_OPERATION_KINDS.length)
  })

  test("the authority dispatch table has EXACTLY the union kinds (no unrouted op)", () => {
    expect([...objectiveMutationDispatchKeys()].sort()).toEqual(
      [...OBJECTIVE_OPERATION_KINDS].sort(),
    )
  })

  test("the kind predicate is a two-way guard (rejects a non-kind AND the retired kinds)", () => {
    for (const k of OBJECTIVE_OPERATION_KINDS) expect(isObjectiveOperationKind(k)).toBe(true)
    expect(isObjectiveOperationKind("wizardry")).toBe(false)
    // GOAL-01: the retired v1 kinds are NOT operations any more.
    expect(isObjectiveOperationKind("set")).toBe(false)
    expect(isObjectiveOperationKind("updateStatus")).toBe(false)
    expect(isObjectiveOperationKind("recordUsage")).toBe(false)
  })
})

describe("C1 — every operation routes through the authority with a live effect", () => {
  const auth = (): ReturnType<typeof createObjectiveAuthority> => {
    const a = createObjectiveAuthority({})
    a.commit(
      a.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "seed", successCriteria: ["c1"] } },
      }),
      { admitted: true },
    )
    return a
  }

  // Each entry: run the op through the authority, assert an effect that ONLY that
  // op produces. Deleting the op's dispatch handler makes its assertion RED.
  const effects: Record<string, (a: ReturnType<typeof createObjectiveAuthority>) => void> = {
    create: (a) => {
      // A SECOND thread — the seed thread already has an objective (`create`
      // there is `objective-exists`), so the live effect is a fresh generation.
      expect(a.get("fresh")).toBeNull()
      const res = a.commit(
        a.prepare({
          threadId: "fresh",
          actor: "system",
          mutation: { kind: "create", definition: { goal: "created" } },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(true)
      expect(a.get("fresh")?.goal).toBe("created")
      expect(a.get("fresh")?.objectiveId).not.toBe("")
      expect(a.get("fresh")?.createdBy).toBe("system")
    },
    replace: (a) => {
      const before = a.get("t")?.objectiveId ?? ""
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "replace", definition: { goal: "replaced" } },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.goal).toBe("replaced")
      // GOAL-01: a replace mints a NEW generation id.
      expect(a.get("t")?.objectiveId).not.toBe(before)
    },
    clear: (a) => {
      const before = a.readDomain("t").revision
      const res = a.commit(
        a.prepare({ threadId: "t", actor: "system", mutation: { kind: "clear" } }),
        { admitted: true },
      )
      expect(res.ok).toBe(true)
      // GOAL-01: real deletion + a revision tombstone on the thread.
      expect(a.get("t")).toBeNull()
      expect(a.readDomain("t").revision).toBe(before + 1)
      expect(a.knownThreadIds()).toContain("t")
    },
    setExplicitStatus: (a) => {
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "setExplicitStatus", status: "paused" },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.status).toBe("paused")
    },
    addBlocker: (a) => {
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "addBlocker", reason: "r", waitingOn: "user" },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.blockers.length).toBe(1)
    },
    clearBlocker: (a) => {
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "addBlocker", reason: "r", waitingOn: "user" },
        }),
        { admitted: true },
      )
      const id = a.get("t")?.blockers[0]?.id ?? ""
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "clearBlocker", blockerId: id },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.blockers.length).toBe(0)
    },
    setNextActions: (a) => {
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "setNextActions", actions: ["n1"] },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.nextActions).toEqual(["n1"])
    },
    markCriterion: (a) => {
      const cid = a.get("t")?.successCriteria[0]?.id ?? ""
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "markCriterion", criterionId: cid, met: true },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.successCriteria[0]?.met).toBe(true)
    },
    markCriterionVerified: (a) => {
      // Replace with a CHECKED criterion, then complete it via a verifier receipt
      // (RFC-03 C4). Deleting this handler removes the only path to complete a
      // checked criterion ⇒ this assertion goes RED.
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: {
            kind: "replace",
            definition: {
              goal: "checked",
              criteria: [
                {
                  text: "tests pass",
                  check: { kind: "command", argv: ["x"], timeoutMs: 1, successExitCodes: [0] },
                },
              ],
            },
          },
        }),
        { admitted: true },
      )
      const c = a.get("t")?.successCriteria[0]
      const cid = c?.id ?? ""
      const checkId = c?.kind === "checked" ? c.check.id : ""
      const rev = a.readDomain("t").revision
      const res = a.commit(
        a.prepare({
          threadId: "t",
          actor: "verifier",
          mutation: {
            kind: "markCriterionVerified",
            criterionId: cid,
            receipt: {
              source: "verifier",
              objectiveId: a.get("t")?.objectiveId ?? "",
              checkId,
              objectiveRevision: rev,
              sourceDigest: "sha256:d",
              verifierResult: { exitCode: 0, passed: true },
              verifiedAt: 1,
            },
          },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(true)
      expect(a.get("t")?.successCriteria[0]?.met).toBe(true)
    },
    amendBudget: (a) => {
      expect(a.get("t")?.budget.maxTurns).toBeUndefined()
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "amendBudget", budget: { maxTurns: 9 } },
        }),
        { admitted: true },
      )
      expect(a.get("t")?.budget.maxTurns).toBe(9)
    },
    settleAttempt: (a) => {
      // GOAL-01: the HOST-measured settlement is the ONLY budget debit and the
      // only progress-receipt producer.
      const dom = a.readDomain("t")
      expect(dom.progressReceipts ?? []).toHaveLength(0)
      const res = a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: {
            kind: "settleAttempt",
            settlement: {
              objectiveId: dom.state?.objective.objectiveId ?? "",
              attemptId: nextAttemptId(),
              startedRevision: dom.revision,
              tokensUsed: 7,
              turnsUsed: 1,
              outcome: "completed",
              executionMode: "foreground",
              criterionIdsBefore: [],
              verifierReceiptIdsBefore: [],
              recordedAt: 1,
            },
          },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(true)
      expect(a.get("t")?.budget.tokensUsed).toBe(7)
      expect(a.get("t")?.budget.turnsUsed).toBe(1)
      expect(a.readDomain("t").progressReceipts).toHaveLength(1)
    },
    markUsageLimited: (a) => {
      // enforce store surfaces the derived status; here we assert the window is
      // recorded (revision advanced by the op even under the informational store).
      const before = a.readDomain("t").revision
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "markUsageLimited", untilEpochMs: Date.now() + 60_000 },
        }),
        { admitted: true },
      )
      expect(a.readDomain("t").revision).toBe(before + 1)
    },
    restore: (a) => {
      const prior = a.readDomain("t")
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "setNextActions", actions: ["gone"] },
        }),
        { admitted: true },
      )
      const res = a.restore(prior, a.readDomain("t").revision)
      expect(res.ok).toBe(true)
      expect(a.get("t")?.nextActions ?? []).toEqual(prior.state?.objective.nextActions ?? [])
    },
  }

  test("every union kind has a live-effect assertion (no unrouted op)", () => {
    expect(Object.keys(effects).sort()).toEqual([...OBJECTIVE_OPERATION_KINDS].sort())
  })

  for (const kind of OBJECTIVE_OPERATION_KINDS) {
    test(`op '${kind}' routes through the authority and takes effect`, () => {
      const fn = effects[kind]
      if (fn === undefined) throw new Error(`no live-effect assertion for op '${kind}'`)
      fn(auth())
    })
  }
})

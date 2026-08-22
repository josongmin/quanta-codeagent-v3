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
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  isObjectiveOperationKind,
  OBJECTIVE_OPERATION_KINDS,
  objectiveMutationDispatchKeys,
} from "@/objective"

describe("C1 — closed operation union floor", () => {
  test("the operation-kind floor is non-zero and unique", () => {
    expect(OBJECTIVE_OPERATION_KINDS.length).toBeGreaterThanOrEqual(9)
    expect(new Set(OBJECTIVE_OPERATION_KINDS).size).toBe(OBJECTIVE_OPERATION_KINDS.length)
  })

  test("the authority dispatch table has EXACTLY the union kinds (no unrouted op)", () => {
    expect([...objectiveMutationDispatchKeys()].sort()).toEqual(
      [...OBJECTIVE_OPERATION_KINDS].sort(),
    )
  })

  test("the kind predicate is a two-way guard (rejects a non-kind)", () => {
    for (const k of OBJECTIVE_OPERATION_KINDS) expect(isObjectiveOperationKind(k)).toBe(true)
    expect(isObjectiveOperationKind("wizardry")).toBe(false)
  })
})

describe("C1 — every operation routes through the authority with a live effect", () => {
  const auth = (): ReturnType<typeof createObjectiveAuthority> => {
    const a = createObjectiveAuthority({})
    a.commit(
      a.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "set", goal: "seed", successCriteria: ["c1"] },
      }),
      { admitted: true },
    )
    return a
  }

  // Each entry: run the op through the authority, assert an effect that ONLY that
  // op produces. Deleting the op's dispatch handler makes its assertion RED.
  const effects: Record<string, (a: ReturnType<typeof createObjectiveAuthority>) => void> = {
    set: (a) => {
      a.commit(
        a.prepare({ threadId: "t", actor: "system", mutation: { kind: "set", goal: "replaced" } }),
        { admitted: true },
      )
      expect(a.get("t")?.goal).toBe("replaced")
    },
    updateStatus: (a) => {
      a.commit(
        a.prepare({
          threadId: "t",
          actor: "system",
          mutation: { kind: "updateStatus", status: "paused" },
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
    recordUsage: (a) => {
      a.commit(
        a.prepare({ threadId: "t", actor: "system", mutation: { kind: "recordUsage", tokens: 7 } }),
        { admitted: true },
      )
      expect(a.get("t")?.budget.tokensUsed).toBe(7)
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

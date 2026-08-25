/**
 * RFC-03 C1 hellgate — revisioned objective mutation authority.
 *
 * Pins the THREE current defects this packet closes and proves the authority
 * fixes each without regressing gate-OFF behavior:
 *
 *   (a) CAS — two concurrent writers at revision N both succeed TODAY (the raw
 *       store has no revision → last-write-wins clobber). The authority must let
 *       exactly ONE of two prepare/commit cycles at the same revision commit;
 *       the other gets a `stale` rejection and does NOT overwrite the winner.
 *
 *   (b) criterion completion authority — the MODEL can self-complete a criterion
 *       TODAY (`markCriterion(met:true)` → derivation auto-completes). Under the
 *       propose gate the authority must REFUSE a model-actor completion; only a
 *       system/verifier actor may complete. Gate-OFF stays byte-identical (model
 *       self-mark still works).
 *
 *   (c) exact restore — a surface-local `replace` cannot exact-restore a prior
 *       objective (it re-mints criterion ids and drops `met`). The authority's
 *       `restore(prior, expectedRevision)` must restore ids / met / status /
 *       blockers / nextActions EXACTLY, and CAS-reject a stale restore so an undo
 *       never clobbers a later edit.
 */

import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  createObjectiveStore,
  type ObjectiveMutationCommand,
} from "@/objective"

const seed = (
  auth: ReturnType<typeof createObjectiveAuthority>,
  threadId: string,
  criteria: readonly string[] = [],
): void => {
  auth.commit(
    auth.prepare({
      threadId,
      actor: "system",
      mutation: { kind: "create", definition: { goal: "g", successCriteria: criteria } },
    }),
    { admitted: true },
  )
}

const cmd = (
  over: Partial<ObjectiveMutationCommand> & { threadId: string },
): ObjectiveMutationCommand =>
  ({
    actor: "system",
    mutation: { kind: "setNextActions", actions: ["x"] },
    ...over,
  }) as ObjectiveMutationCommand

// ─────────────────────────────────────────────────────────────────────────────
// (a) CAS — exactly one of two writers at revision N commits
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 (a) — CAS revision conflict", () => {
  test("DEFECT WITNESS: the raw store lets two writers at the same state both succeed", () => {
    // Documents today's behavior: no revision, last write silently wins.
    const store = createObjectiveStore()
    store.create("t", { goal: "g" })
    const a = store.setNextActions("t", ["A"])
    const b = store.setNextActions("t", ["B"])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull() // both "succeed"; A is silently clobbered
    expect(store.get("t")?.nextActions).toEqual(["B"])
  })

  test("exactly ONE of two prepares at revision N commits; the other is stale", () => {
    const auth = createObjectiveAuthority({})
    seed(auth, "t")
    const revBefore = auth.readDomain("t").revision

    const p1 = auth.prepare(
      cmd({ threadId: "t", mutation: { kind: "setNextActions", actions: ["A"] } }),
    )
    const p2 = auth.prepare(
      cmd({ threadId: "t", mutation: { kind: "setNextActions", actions: ["B"] } }),
    )
    expect(p1.expectedRevision).toBe(revBefore)
    expect(p2.expectedRevision).toBe(revBefore)

    const c1 = auth.commit(p1, { admitted: true })
    const c2 = auth.commit(p2, { admitted: true })

    expect(c1.ok).toBe(true)
    expect(c2.ok).toBe(false)
    if (c2.ok === false) expect(c2.reason).toBe("stale")

    // The winner (A) survives; the stale writer did NOT clobber it.
    expect(auth.get("t")?.nextActions).toEqual(["A"])
    if (c1.ok) expect(c1.revision).toBe(revBefore + 1)
  })

  test("a stale writer can retry against the NEW revision and then commit", () => {
    const auth = createObjectiveAuthority({})
    seed(auth, "t")
    const p1 = auth.prepare(
      cmd({ threadId: "t", mutation: { kind: "setNextActions", actions: ["A"] } }),
    )
    const p2 = auth.prepare(
      cmd({ threadId: "t", mutation: { kind: "setNextActions", actions: ["B"] } }),
    )
    auth.commit(p1, { admitted: true })
    expect(auth.commit(p2, { admitted: true }).ok).toBe(false)
    const p2b = auth.prepare(
      cmd({ threadId: "t", mutation: { kind: "setNextActions", actions: ["B"] } }),
    )
    expect(auth.commit(p2b, { admitted: true }).ok).toBe(true)
    expect(auth.get("t")?.nextActions).toEqual(["B"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (b) criterion completion authority — model cannot self-complete
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 (b) — criterion completion authority", () => {
  test("DEFECT WITNESS: today a model self-mark auto-completes the objective", () => {
    const store = createObjectiveStore()
    store.create("t", { goal: "g", successCriteria: ["done"] })
    const cid = store.get("t")?.successCriteria[0]?.id ?? ""
    store.markCriterion("t", cid, true)
    expect(store.get("t")?.status).toBe("completed") // self-completion, no gate
  })

  test("gate ON: a MODEL markCriterion(met:true) is refused (forbidden-completion)", () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    seed(auth, "t", ["done"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.reason).toBe("forbidden-completion")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(auth.get("t")?.status).not.toBe("completed")
  })

  test("gate ON: a VERIFIER/system actor CAN complete a criterion", () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    seed(auth, "t", ["done"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "verifier",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(true)
    expect(auth.get("t")?.status).toBe("completed")
  })

  test("gate OFF: model self-mark still completes (byte-identical legacy)", () => {
    const auth = createObjectiveAuthority({ gateOn: false })
    seed(auth, "t", ["done"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(true)
    expect(auth.get("t")?.status).toBe("completed")
  })

  test("gate ON: model may still UNmark (met:false) — only completion is owned", () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    seed(auth, "t", ["done"])
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    // verifier completes, then model unmarks (allowed — not a completion)
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "verifier",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: cid, met: false },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(true)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (c) exact restore + stale-undo protection
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 (c) — exact restore", () => {
  test("DEFECT WITNESS: a surface-local `replace` re-mints ids and drops met", () => {
    const store = createObjectiveStore()
    store.create("t", { goal: "g", successCriteria: ["done"] })
    const before = store.get("t")?.successCriteria[0]
    store.markCriterion("t", before?.id ?? "", true)
    // "restore" by re-declaring the same text: ids differ, met is lost
    // (GOAL-01: `replace` also mints a NEW objectiveId — a fresh generation).
    const oldObjectiveId = store.get("t")?.objectiveId
    store.replace("t", { goal: "g", successCriteria: ["done"] })
    expect(store.get("t")?.objectiveId).not.toBe(oldObjectiveId)
    const after = store.get("t")?.successCriteria[0]
    expect(after?.id).not.toBe(before?.id)
    expect(after?.met).toBe(false)
  })

  test("restore(prior, rev) restores ids / met / status / blockers / nextActions EXACTLY", () => {
    const auth = createObjectiveAuthority({})
    seed(auth, "t", ["done", "shipped"])
    auth.setNextActions("t", ["a", "b"])
    auth.addBlocker("t", { reason: "waiting", waitingOn: "user" })
    const prior = auth.readDomain("t")
    const priorCrit = auth.get("t")?.successCriteria ?? []
    const priorBlockerId = auth.get("t")?.blockers[0]?.id

    // Mutate away from the snapshot.
    auth.clearBlocker("t", priorBlockerId ?? "")
    auth.setNextActions("t", ["changed"])
    auth.markCriterion("t", priorCrit[0]?.id ?? "", true)

    const res = auth.restore(prior, auth.readDomain("t").revision)
    expect(res.ok).toBe(true)

    const restored = auth.get("t")
    expect(restored?.successCriteria.map((c) => c.id)).toEqual(priorCrit.map((c) => c.id))
    expect(restored?.successCriteria.map((c) => c.met)).toEqual(priorCrit.map((c) => c.met))
    expect(restored?.nextActions).toEqual(["a", "b"])
    expect(restored?.blockers[0]?.id).toBe(priorBlockerId)
    expect(restored?.status).toBe("blocked")
  })

  test("a STALE restore is CAS-rejected and does NOT clobber the winner", () => {
    const auth = createObjectiveAuthority({})
    seed(auth, "t", ["done"])
    const prior = auth.readDomain("t")
    // A later edit bumps the revision past the snapshot the undo captured.
    auth.setNextActions("t", ["winner"])
    const res = auth.restore(prior, prior.revision) // stale expectedRevision
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.reason).toBe("stale")
    expect(auth.get("t")?.nextActions).toEqual(["winner"]) // winner preserved
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// actor/thread binding + gate-OFF ObjectivePort byte-identical delegation
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — actor/thread binding + gate-OFF delegation", () => {
  test("the command's bound threadId is authoritative (not any model field)", () => {
    const auth = createObjectiveAuthority({})
    auth.commit(
      auth.prepare({
        threadId: "session-bound",
        actor: "model",
        mutation: { kind: "create", definition: { goal: "g" } },
      }),
      { admitted: true },
    )
    expect(auth.get("session-bound")?.goal).toBe("g")
    expect(auth.get("other")).toBeNull()
  })

  test("gate OFF: ObjectivePort surface behaves like the raw store", () => {
    const auth = createObjectiveAuthority({})
    const store = createObjectiveStore()
    auth.create("t", { goal: "g", successCriteria: ["x"] })
    store.create("t", { goal: "g", successCriteria: ["x"] })
    const ao = auth.get("t")
    const so = store.get("t")
    expect(ao?.goal).toBe(so?.goal)
    expect(ao?.status).toBe(so?.status)
    expect(ao?.successCriteria.length).toBe(so?.successCriteria.length)
  })

  test("gate ON: a model-originated create requires approval; unadmitted is refused", () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    const prepared = auth.prepare({
      threadId: "t",
      actor: "model",
      mutation: { kind: "create", definition: { goal: "g" } },
    })
    expect(prepared.approvalRequired).toBe(true)
    const denied = auth.commit(prepared, { admitted: false })
    expect(denied.ok).toBe(false)
    if (denied.ok === false) expect(denied.reason).toBe("approval-required")
    expect(auth.get("t")).toBeNull() // nothing committed before admission
    const ok = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "create", definition: { goal: "g" } },
      }),
      { admitted: true },
    )
    expect(ok.ok).toBe(true)
  })

  test("gate ON: a SYSTEM-originated mutation never requires approval", () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    const prepared = auth.prepare({
      threadId: "t",
      actor: "system",
      mutation: { kind: "create", definition: { goal: "g" } },
    })
    expect(prepared.approvalRequired).toBe(false)
    expect(auth.commit(prepared, { admitted: false }).ok).toBe(true)
  })
})

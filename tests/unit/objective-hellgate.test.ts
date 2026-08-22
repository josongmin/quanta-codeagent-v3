/**
 * HELLGATE — adversarial proofs for ADR-0394: Objective as a first-class
 * per-thread object (MODEL ONLY wave — store + port, no agent-loop wiring).
 *
 * The store is a pure new slice (`@/objective`). These cases pin the
 * CLOSED port contract verbatim:
 *
 *   - set/get round-trip + frozen-snapshot determinism.
 *   - unknown-threadId ⇒ null on EVERY mutator and on get.
 *   - blocker add/clear lifecycle + the `status === "blocked"` invariant
 *     (non-empty blockers force "blocked"; clearing the last one releases it).
 *   - all-criteria-met ⇒ "completed" derivation — but NEVER when blocked.
 *   - recordUsage token/turn accumulation (monotonic, clamps negatives).
 *   - snapshot round-trip (toSnapshot → fromSnapshot deep-equal, byte-stable).
 *   - NO-THROW on malformed / hostile input (no method ever throws).
 *   - multi-thread isolation (mutating one thread never touches another).
 *
 * STATUS DERIVATION RULE (pinned here + documented in the ADR):
 *   1. blockers.length > 0          ⇒ status = "blocked"   (highest priority)
 *   2. else all criteria met (>=1)  ⇒ status = "completed"  (auto-derive)
 *   3. else                          ⇒ the last explicit updateStatus() value,
 *                                      defaulting to "active".
 *   updateStatus("completed") is honored only while NOT blocked.
 */
import { describe, expect, test } from "bun:test"
import type { Objective, ObjectivePort, ObjectiveSnapshot } from "@/objective"
import { createObjectiveStore } from "@/objective"

const TID = "thread-alpha"

const freshStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

describe("HELLGATE [ADR-0394] — set/get round-trip", () => {
  test("set returns a fully-populated, frozen Objective", () => {
    const store = freshStore(42)
    const obj = store.set(TID, {
      goal: "Ship the objective slice",
      successCriteria: ["tests pass", "tsc clean"],
      budget: { maxTokens: 1000, maxTurns: 8 },
    })
    expect(obj.threadId).toBe(TID)
    expect(obj.goal).toBe("Ship the objective slice")
    expect(obj.status).toBe("active")
    expect(obj.successCriteria).toHaveLength(2)
    expect(obj.successCriteria.every((c) => c.met === false)).toBe(true)
    expect(obj.successCriteria[0]?.text).toBe("tests pass")
    expect(obj.budget).toEqual({
      maxTokens: 1000,
      tokensUsed: 0,
      maxTurns: 8,
      turnsUsed: 0,
    })
    expect(obj.blockers).toEqual([])
    expect(obj.nextActions).toEqual([])
    expect(obj.createdAt).toBe(42)
    expect(obj.updatedAt).toBe(42)
    expect(Object.isFrozen(obj)).toBe(true)
    expect(Object.isFrozen(obj.successCriteria)).toBe(true)
    expect(Object.isFrozen(obj.blockers)).toBe(true)
  })

  test("get returns the stored objective", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    const got = store.get(TID)
    expect(got).not.toBeNull()
    expect(got?.goal).toBe("g")
  })

  test("set with no criteria / no budget yields sensible defaults", () => {
    const store = freshStore()
    const obj = store.set(TID, { goal: "bare" })
    expect(obj.successCriteria).toEqual([])
    expect(obj.budget).toEqual({ tokensUsed: 0, turnsUsed: 0 })
    expect(obj.status).toBe("active")
  })

  test("each successCriterion gets a unique id", () => {
    const store = freshStore()
    const obj = store.set(TID, { goal: "g", successCriteria: ["a", "b", "c"] })
    const ids = obj.successCriteria.map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => id.length > 0)).toBe(true)
  })

  test("set overwrites an existing objective for the same thread", () => {
    const store = freshStore()
    store.set(TID, { goal: "first" })
    const second = store.set(TID, { goal: "second" })
    expect(second.goal).toBe("second")
    expect(store.list()).toHaveLength(1)
  })
})

describe("HELLGATE [ADR-0394] — unknown-threadId ⇒ null on every accessor", () => {
  test("get on a missing thread returns null", () => {
    expect(freshStore().get("nope")).toBeNull()
  })

  test("every mutator returns null for an unknown thread", () => {
    const store = freshStore()
    expect(store.updateStatus("nope", "blocked")).toBeNull()
    expect(store.addBlocker("nope", { reason: "r", waitingOn: "user" })).toBeNull()
    expect(store.clearBlocker("nope", "bid")).toBeNull()
    expect(store.setNextActions("nope", ["x"])).toBeNull()
    expect(store.markCriterion("nope", "cid", true)).toBeNull()
    expect(store.recordUsage("nope", { tokens: 1 })).toBeNull()
  })
})

describe("HELLGATE [ADR-0394] — blocker lifecycle + status='blocked' invariant", () => {
  test("addBlocker forces status='blocked' and stamps `since`", () => {
    const store = freshStore(500)
    store.set(TID, { goal: "g" })
    const after = store.addBlocker(TID, { reason: "awaiting CI", waitingOn: "network" })
    expect(after?.status).toBe("blocked")
    expect(after?.blockers).toHaveLength(1)
    expect(after?.blockers[0]?.reason).toBe("awaiting CI")
    expect(after?.blockers[0]?.waitingOn).toBe("network")
    expect(after?.blockers[0]?.since).toBe(500)
    expect(after?.blockers[0]?.id.length).toBeGreaterThan(0)
  })

  test("blocked status cannot be overridden by updateStatus while a blocker exists", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    store.addBlocker(TID, { reason: "r", waitingOn: "tool" })
    const tryActive = store.updateStatus(TID, "active")
    expect(tryActive?.status).toBe("blocked")
    const tryCompleted = store.updateStatus(TID, "completed")
    expect(tryCompleted?.status).toBe("blocked")
  })

  test("clearing the LAST blocker releases the blocked status back to active", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    const added = store.addBlocker(TID, { reason: "r", waitingOn: "child_agent" })
    const bid = added?.blockers[0]?.id ?? ""
    const cleared = store.clearBlocker(TID, bid)
    expect(cleared?.blockers).toHaveLength(0)
    expect(cleared?.status).toBe("active")
  })

  test("clearing a non-existent blocker id is a no-op (still returns the objective)", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    store.addBlocker(TID, { reason: "r", waitingOn: "user" })
    const res = store.clearBlocker(TID, "does-not-exist")
    expect(res).not.toBeNull()
    expect(res?.blockers).toHaveLength(1)
    expect(res?.status).toBe("blocked")
  })

  test("two blockers; clearing one keeps blocked until both cleared", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    const a = store.addBlocker(TID, { reason: "a", waitingOn: "user" })
    store.addBlocker(TID, { reason: "b", waitingOn: "tool" })
    const idA = a?.blockers[0]?.id ?? ""
    const afterOne = store.clearBlocker(TID, idA)
    expect(afterOne?.blockers).toHaveLength(1)
    expect(afterOne?.status).toBe("blocked")
    const idB = afterOne?.blockers[0]?.id ?? ""
    const afterTwo = store.clearBlocker(TID, idB)
    expect(afterTwo?.status).toBe("active")
  })
})

describe("HELLGATE [ADR-0394] — all-criteria-met ⇒ 'completed' derivation", () => {
  test("marking all criteria met auto-derives status='completed'", () => {
    const store = freshStore()
    const obj = store.set(TID, { goal: "g", successCriteria: ["x", "y"] })
    const idX = obj.successCriteria[0]?.id ?? ""
    const idY = obj.successCriteria[1]?.id ?? ""
    expect(store.markCriterion(TID, idX, true)?.status).toBe("active")
    expect(store.markCriterion(TID, idY, true)?.status).toBe("completed")
  })

  test("with zero criteria, completion is NOT auto-derived (vacuous truth rejected)", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    expect(store.get(TID)?.status).toBe("active")
  })

  test("unmarking a criterion reverts 'completed' back to active", () => {
    const store = freshStore()
    const obj = store.set(TID, { goal: "g", successCriteria: ["x"] })
    const id = obj.successCriteria[0]?.id ?? ""
    expect(store.markCriterion(TID, id, true)?.status).toBe("completed")
    expect(store.markCriterion(TID, id, false)?.status).toBe("active")
  })

  test("a blocker SUPPRESSES auto-completion even when all criteria are met", () => {
    const store = freshStore()
    const obj = store.set(TID, { goal: "g", successCriteria: ["x"] })
    const id = obj.successCriteria[0]?.id ?? ""
    store.addBlocker(TID, { reason: "r", waitingOn: "user" })
    const marked = store.markCriterion(TID, id, true)
    expect(marked?.status).toBe("blocked")
    // clearing the blocker NOW lets the met criteria complete it
    const bid = marked?.blockers[0]?.id ?? ""
    const cleared = store.clearBlocker(TID, bid)
    expect(cleared?.status).toBe("completed")
  })

  test("marking an unknown criterion id is a no-op (returns objective unchanged)", () => {
    const store = freshStore()
    store.set(TID, { goal: "g", successCriteria: ["x"] })
    const res = store.markCriterion(TID, "ghost", true)
    expect(res).not.toBeNull()
    expect(res?.successCriteria.every((c) => c.met === false)).toBe(true)
    expect(res?.status).toBe("active")
  })
})

describe("HELLGATE [ADR-0394] — recordUsage accumulation", () => {
  test("tokens and turns accumulate across calls", () => {
    const store = freshStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 100, maxTurns: 5 } })
    store.recordUsage(TID, { tokens: 30 })
    store.recordUsage(TID, { tokens: 20, turns: 2 })
    const obj = store.recordUsage(TID, { turns: 1 })
    expect(obj?.budget.tokensUsed).toBe(50)
    expect(obj?.budget.turnsUsed).toBe(3)
    expect(obj?.budget.maxTokens).toBe(100)
    expect(obj?.budget.maxTurns).toBe(5)
  })

  test("negative / NaN usage deltas are clamped to a no-op (never decrement)", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    store.recordUsage(TID, { tokens: 10, turns: 2 })
    const obj = store.recordUsage(TID, {
      tokens: -100,
      turns: Number.NaN,
    } as { tokens: number; turns: number })
    expect(obj?.budget.tokensUsed).toBe(10)
    expect(obj?.budget.turnsUsed).toBe(2)
  })

  test("recordUsage does NOT alter status derivation", () => {
    const store = freshStore()
    store.set(TID, { goal: "g", successCriteria: ["x"] })
    const obj = store.recordUsage(TID, { tokens: 1 })
    expect(obj?.status).toBe("active")
  })
})

describe("HELLGATE [ADR-0394] — nextActions", () => {
  test("setNextActions replaces (not appends) and freezes the array", () => {
    const store = freshStore()
    store.set(TID, { goal: "g" })
    store.setNextActions(TID, ["step 1", "step 2"])
    const obj = store.setNextActions(TID, ["only step"])
    expect(obj?.nextActions).toEqual(["only step"])
    expect(Object.isFrozen(obj?.nextActions)).toBe(true)
  })
})

describe("HELLGATE [ADR-0394] — snapshot round-trip", () => {
  test("toSnapshot → fromSnapshot reproduces an identical store (deep-equal)", () => {
    const store = freshStore(777)
    store.set("t1", { goal: "first", successCriteria: ["a"], budget: { maxTokens: 50 } })
    store.set("t2", { goal: "second" })
    store.addBlocker("t2", { reason: "wait", waitingOn: "user" })
    store.recordUsage("t1", { tokens: 7, turns: 1 })
    const snap = store.toSnapshot()

    const restored = freshStore(999)
    restored.fromSnapshot(snap)
    expect(restored.toSnapshot()).toEqual(snap)
    expect(restored.get("t1")?.goal).toBe("first")
    expect(restored.get("t2")?.status).toBe("blocked")
    expect(restored.get("t1")?.budget.tokensUsed).toBe(7)
  })

  test("snapshot serializes byte-stable through JSON", () => {
    const store = freshStore(1)
    store.set("t1", { goal: "g", successCriteria: ["a", "b"] })
    const snap = store.toSnapshot()
    const round = JSON.parse(JSON.stringify(snap)) as ObjectiveSnapshot
    const restored = freshStore(2)
    restored.fromSnapshot(round)
    expect(JSON.stringify(restored.toSnapshot())).toBe(JSON.stringify(snap))
  })

  test("fromSnapshot REPLACES prior state (does not merge)", () => {
    const store = freshStore()
    store.set("old", { goal: "old goal" })
    const empty: ObjectiveSnapshot = { objectives: [] }
    store.fromSnapshot(empty)
    expect(store.get("old")).toBeNull()
    expect(store.list()).toHaveLength(0)
  })
})

describe("HELLGATE [ADR-0394] — NO-THROW on malformed / hostile input", () => {
  test("set tolerates malformed init without throwing", () => {
    const store = freshStore()
    expect(() =>
      store.set(TID, {
        goal: "g",
        // hostile: non-string entries inside successCriteria
        successCriteria: [null, 42, "ok"] as unknown as readonly string[],
      }),
    ).not.toThrow()
    const obj = store.get(TID)
    // malformed entries are coerced/skipped; "ok" must survive
    expect(obj?.successCriteria.some((c) => c.text === "ok")).toBe(true)
  })

  test("null/undefined threadId passed to any method never throws", () => {
    const store = freshStore()
    const bad = null as unknown as string
    expect(() => store.get(bad)).not.toThrow()
    expect(() => store.updateStatus(bad, "active")).not.toThrow()
    expect(() => store.addBlocker(bad, { reason: "r", waitingOn: "user" })).not.toThrow()
    expect(() => store.clearBlocker(bad, "x")).not.toThrow()
    expect(() => store.setNextActions(bad, [])).not.toThrow()
    expect(() => store.markCriterion(bad, "x", true)).not.toThrow()
    expect(() => store.recordUsage(bad, {})).not.toThrow()
    expect(store.get(bad)).toBeNull()
  })

  test("fromSnapshot tolerates a malformed snapshot without throwing", () => {
    const store = freshStore()
    expect(() => store.fromSnapshot({} as unknown as ObjectiveSnapshot)).not.toThrow()
    expect(() =>
      store.fromSnapshot({ objectives: null } as unknown as ObjectiveSnapshot),
    ).not.toThrow()
    expect(() =>
      store.fromSnapshot({
        objectives: [{ junk: true }],
      } as unknown as ObjectiveSnapshot),
    ).not.toThrow()
    expect(store.list()).toEqual([])
  })

  test("an empty-goal set still produces a usable objective (no throw)", () => {
    const store = freshStore()
    expect(() => store.set(TID, { goal: "" })).not.toThrow()
    expect(store.get(TID)).not.toBeNull()
  })
})

describe("HELLGATE [ADR-0394] — multi-thread isolation", () => {
  test("mutating one thread never touches a sibling thread", () => {
    const store = freshStore()
    store.set("a", { goal: "A", successCriteria: ["a1"] })
    store.set("b", { goal: "B", successCriteria: ["b1"] })
    store.addBlocker("a", { reason: "r", waitingOn: "user" })
    store.recordUsage("a", { tokens: 99 })

    const b = store.get("b")
    expect(b?.status).toBe("active")
    expect(b?.blockers).toHaveLength(0)
    expect(b?.budget.tokensUsed).toBe(0)
    expect(b?.goal).toBe("B")
  })

  test("list returns all objectives independently", () => {
    const store = freshStore()
    store.set("a", { goal: "A" })
    store.set("b", { goal: "B" })
    store.set("c", { goal: "C" })
    const goals = store
      .list()
      .map((o: Objective) => o.goal)
      .sort()
    expect(goals).toEqual(["A", "B", "C"])
  })

  test("the snapshot from list() is a defensive copy (mutating it cannot corrupt the store)", () => {
    const store = freshStore()
    store.set("a", { goal: "A" })
    const listed = store.list()
    // the returned array is frozen; a hostile push is rejected (silently in
    // sloppy mode, with a TypeError in strict mode) — either way the store is
    // unreachable from the caller's reference.
    expect(Object.isFrozen(listed)).toBe(true)
    try {
      ;(listed as unknown as { push: (x: unknown) => void }).push({})
    } catch {
      /* frozen array throws in strict mode — expected, store stays intact */
    }
    expect(store.list()).toHaveLength(1)
  })
})

describe("HELLGATE [ADR-0394] — updatedAt clock seam", () => {
  test("mutations advance updatedAt via the injected clock, createdAt is sticky", () => {
    let t = 100
    const store = createObjectiveStore({ now: () => t })
    const created = store.set(TID, { goal: "g" })
    expect(created.createdAt).toBe(100)
    expect(created.updatedAt).toBe(100)
    t = 250
    const mutated = store.setNextActions(TID, ["x"])
    expect(mutated?.createdAt).toBe(100)
    expect(mutated?.updatedAt).toBe(250)
  })

  test("default clock (Date.now) is used when no opts are given", () => {
    const before = Date.now()
    const store = createObjectiveStore()
    const obj = store.set(TID, { goal: "g" })
    const after = Date.now()
    expect(obj.createdAt).toBeGreaterThanOrEqual(before)
    expect(obj.createdAt).toBeLessThanOrEqual(after)
  })

  // Audit R2 (F3): bounded growth defensive caps. The agent populates its own
  // threads, but a pathological loop could otherwise grow these unbounded.
  test("successCriteria capped at MAX_CRITERIA_PER_OBJECTIVE (256) — extras dropped", () => {
    const store = createObjectiveStore({ now: () => 1000 })
    const huge = Array.from({ length: 300 }, (_, i) => `criterion-${i}`)
    const obj = store.set(TID, { goal: "g", successCriteria: huge })
    expect(obj.successCriteria.length).toBe(256)
    expect(obj.successCriteria[0]?.text).toBe("criterion-0")
    expect(obj.successCriteria[255]?.text).toBe("criterion-255")
  })

  test("addBlocker capped at MAX_BLOCKERS_PER_OBJECTIVE (64) — extras silently dropped", () => {
    const store = createObjectiveStore({ now: () => 1000 })
    store.set(TID, { goal: "g" })
    for (let i = 0; i < 80; i++) {
      store.addBlocker(TID, { reason: `blk-${i}`, waitingOn: "user" })
    }
    const obj = store.get(TID)
    expect(obj?.blockers.length).toBe(64)
    expect(obj?.blockers[0]?.reason).toBe("blk-0")
    expect(obj?.blockers[63]?.reason).toBe("blk-63")
  })
})

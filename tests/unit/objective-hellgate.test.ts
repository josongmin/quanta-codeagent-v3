/**
 * HELLGATE — adversarial proofs for ADR-0394: Objective as a first-class
 * per-thread object (MODEL ONLY wave — store + port, no agent-loop wiring).
 *
 * The store is a pure new slice (`@/objective`). These cases pin the
 * CLOSED port contract verbatim (GOAL-01 domain v2 surface):
 *
 *   - create/get round-trip + frozen-snapshot determinism.
 *   - create on an occupied thread ⇒ null; replace mints a NEW generation
 *     (fresh `objectiveId`) and resets every evidence family.
 *   - unknown-threadId ⇒ null on EVERY mutator (except `create`, which is the
 *     one operation that legitimately targets an unknown thread) and on get.
 *   - blocker add/clear lifecycle + the `status === "blocked"` invariant
 *     (non-empty blockers force "blocked"; clearing the last one releases it).
 *   - all-criteria-met ⇒ "completed" derivation — but NEVER when blocked.
 *   - HOST-settled usage token/turn accumulation (monotonic, clamps negatives).
 *   - snapshot round-trip (toSnapshot → fromSnapshot deep-equal, byte-stable).
 *   - NO-THROW on malformed / hostile input (no method ever throws).
 *   - multi-thread isolation (mutating one thread never touches another).
 *
 * STATUS DERIVATION RULE (pinned here + documented in the ADR):
 *   1. blockers.length > 0          ⇒ status = "blocked"   (highest priority)
 *   2. else all criteria met (>=1)  ⇒ status = "completed"  (auto-derive)
 *   3. else                          ⇒ the last explicit setExplicitStatus()
 *                                      value (active | paused), default "active".
 *   GOAL-01: there is NO explicit "completed" intent — completion is derived
 *   ONLY from met criteria, and usage is never self-reported (host settlement).
 */
import { describe, expect, test } from "bun:test"
import type { Objective, ObjectivePort, ObjectiveSnapshot } from "@/objective"
import { createObjectiveStore, MAX_GOAL_CHARS } from "@/objective"
import {
  completeAllCriteria,
  seedObjective,
  settleTurns,
  settleUsage,
} from "./objective/v2-helpers"

const TID = "thread-alpha"

const freshStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

describe("HELLGATE [ADR-0394] — create/get round-trip", () => {
  test("create returns a fully-populated, frozen Objective with authority-minted identity", () => {
    let seq = 0
    const store = createObjectiveStore({ now: () => 42, idFactory: () => `obj-${++seq}` })
    const obj = store.create(TID, {
      goal: "Ship the objective slice",
      successCriteria: ["tests pass", "tsc clean"],
      budget: { maxTokens: 1000, maxTurns: 8 },
    })
    expect(obj).not.toBeNull()
    if (obj === null) throw new Error("unreachable")
    expect(obj.threadId).toBe(TID)
    expect(obj.objectiveId).toBe("obj-1")
    expect(obj.createdBy).toBe("system")
    expect(obj.migrationSource).toBeUndefined()
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
    seedObjective(store, TID, { goal: "g" })
    const got = store.get(TID)
    expect(got).not.toBeNull()
    expect(got?.goal).toBe("g")
  })

  test("create with no criteria / no budget yields sensible defaults", () => {
    const store = freshStore()
    const obj = seedObjective(store, TID, { goal: "bare" })
    expect(obj.successCriteria).toEqual([])
    expect(obj.budget).toEqual({ tokensUsed: 0, turnsUsed: 0 })
    expect(obj.status).toBe("active")
  })

  test("each successCriterion gets a unique id", () => {
    const store = freshStore()
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["a", "b", "c"] })
    const ids = obj.successCriteria.map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => id.length > 0)).toBe(true)
  })

  // GOAL-01: the legacy `set` overwrite became two explicit operations. `create`
  // on an occupied thread is REFUSED (null, nothing changes); `replace` mints a
  // brand-new generation id and drops every evidence family of the old one.
  test("create on a thread that already has an objective mints NOTHING and leaves it intact", () => {
    let seq = 0
    const store = createObjectiveStore({ now: () => 1, idFactory: () => `gen-${++seq}` })
    const first = store.create(TID, { goal: "first" })
    expect(first?.objectiveId).toBe("gen-1")
    store.create(TID, { goal: "second" })
    // No second generation was minted and the live one is byte-identical.
    expect(seq).toBe(1)
    expect(store.get(TID)?.goal).toBe("first")
    expect(store.get(TID)?.objectiveId).toBe("gen-1")
    expect(store.list()).toHaveLength(1)
  })

  // Documented contract (`ObjectivePort.create`, src/objective/types.ts): "null
  // when one already exists on the thread". GOAL-02: the system surface now
  // projects a REFUSED outcome as `null` (this used to be kept RED on purpose).
  test("create on a thread that already has an objective returns null (port contract)", () => {
    const store = freshStore()
    expect(store.create(TID, { goal: "first" })).not.toBeNull()
    expect(store.create(TID, { goal: "second" })).toBeNull()
  })

  test("replace mints a NEW generation (fresh objectiveId) and resets evidence", () => {
    let seq = 0
    const store = createObjectiveStore({ now: () => 1, idFactory: () => `gen-${++seq}` })
    const first = seedObjective(store, TID, {
      goal: "first",
      successCriteria: ["x"],
      budget: { maxTurns: 9 },
    })
    expect(first.objectiveId).toBe("gen-1")
    // Accumulate evidence of every family on generation 1.
    completeAllCriteria(store, TID)
    settleUsage(store, TID, { tokens: 40, turns: 1 })
    store.addBlocker(TID, { reason: "r", waitingOn: "user" })
    store.setNextActions(TID, ["step"])
    expect(store.get(TID)?.budget.tokensUsed).toBe(40)
    expect(store.get(TID)?.status).toBe("blocked")

    const second = store.replace(TID, { goal: "second", successCriteria: ["y"] })
    expect(second).not.toBeNull()
    expect(second?.goal).toBe("second")
    expect(second?.objectiveId).toBe("gen-2")
    expect(second?.objectiveId).not.toBe(first.objectiveId)
    expect(second?.successCriteria.every((c) => c.met === false)).toBe(true)
    expect(second?.blockers).toEqual([])
    expect(second?.nextActions).toEqual([])
    expect(second?.budget).toEqual({ tokensUsed: 0, turnsUsed: 0 })
    expect(second?.status).toBe("active")
    expect(store.list()).toHaveLength(1)
  })

  test("replace on a thread without an objective returns null (nothing minted)", () => {
    const store = freshStore()
    expect(store.replace(TID, { goal: "second" })).toBeNull()
    expect(store.get(TID)).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  test("clear deletes the objective; a later create mints a fresh generation", () => {
    let seq = 0
    const store = createObjectiveStore({ now: () => 1, idFactory: () => `gen-${++seq}` })
    seedObjective(store, TID, { goal: "g" })
    expect(store.clear(TID)).toBe(true)
    expect(store.get(TID)).toBeNull()
    expect(store.list()).toHaveLength(0)
    // Nothing live ⇒ a second clear is a no-op `false`.
    expect(store.clear(TID)).toBe(false)
    // The tombstone does not block a new generation.
    const again = store.create(TID, { goal: "again" })
    expect(again?.objectiveId).toBe("gen-2")
  })

  test("amendBudget changes only the caps and never touches *Used", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g", budget: { maxTokens: 10, maxTurns: 2 } })
    settleUsage(store, TID, { tokens: 5, turns: 1 })
    const amended = store.amendBudget(TID, { maxTokens: 500, maxTurns: 20 })
    expect(amended?.budget).toEqual({ maxTokens: 500, tokensUsed: 5, maxTurns: 20, turnsUsed: 1 })
    expect(amended?.objectiveId).toBe(store.get(TID)?.objectiveId ?? "")
  })
})

describe("HELLGATE [ADR-0394] — unknown-threadId ⇒ null on every accessor", () => {
  test("get on a missing thread returns null", () => {
    expect(freshStore().get("nope")).toBeNull()
  })

  test("every mutator returns null for an unknown thread", () => {
    const store = freshStore()
    expect(store.replace("nope", { goal: "g" })).toBeNull()
    expect(store.clear("nope")).toBe(false)
    expect(store.setExplicitStatus("nope", "paused")).toBeNull()
    expect(store.amendBudget("nope", { maxTokens: 1 })).toBeNull()
    expect(store.addBlocker("nope", { reason: "r", waitingOn: "user" })).toBeNull()
    expect(store.clearBlocker("nope", "bid")).toBeNull()
    expect(store.setNextActions("nope", ["x"])).toBeNull()
    expect(store.markCriterion("nope", "cid", true)).toBeNull()
    expect(store.markUsageLimited("nope", 5_000)).toBeNull()
    // GOAL-01: usage is host-settled; a settlement without a live objective is refused.
    const settled = settleUsage(store, "nope", { tokens: 1 })
    expect(settled.ok).toBe(false)
    if (settled.ok) throw new Error("unreachable")
    expect(settled.reason).toBe("objective-missing")
    // None of the refusals minted anything.
    expect(store.get("nope")).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  test("create is the ONE operation that succeeds on an unknown thread", () => {
    const store = freshStore()
    expect(store.create("nope", { goal: "g" })).not.toBeNull()
    expect(store.get("nope")?.goal).toBe("g")
  })
})

describe("HELLGATE [ADR-0394] — blocker lifecycle + status='blocked' invariant", () => {
  test("addBlocker forces status='blocked' and stamps `since`", () => {
    const store = freshStore(500)
    seedObjective(store, TID, { goal: "g" })
    const after = store.addBlocker(TID, { reason: "awaiting CI", waitingOn: "network" })
    expect(after?.status).toBe("blocked")
    expect(after?.blockers).toHaveLength(1)
    expect(after?.blockers[0]?.reason).toBe("awaiting CI")
    expect(after?.blockers[0]?.waitingOn).toBe("network")
    expect(after?.blockers[0]?.since).toBe(500)
    expect(after?.blockers[0]?.id.length).toBeGreaterThan(0)
  })

  test("blocked status cannot be overridden by setExplicitStatus while a blocker exists", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
    store.addBlocker(TID, { reason: "r", waitingOn: "tool" })
    const tryActive = store.setExplicitStatus(TID, "active")
    expect(tryActive?.status).toBe("blocked")
    const tryPaused = store.setExplicitStatus(TID, "paused")
    expect(tryPaused?.status).toBe("blocked")
    // GOAL-01: there is no explicit "completed" any more; the only way to reach
    // it is met criteria — and even that is masked while a blocker stands.
    completeAllCriteria(store, TID)
    expect(store.get(TID)?.status).toBe("blocked")
  })

  test("clearing the LAST blocker releases the blocked status back to active", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    const added = store.addBlocker(TID, { reason: "r", waitingOn: "child_agent" })
    const bid = added?.blockers[0]?.id ?? ""
    const cleared = store.clearBlocker(TID, bid)
    expect(cleared?.blockers).toHaveLength(0)
    expect(cleared?.status).toBe("active")
  })

  test("clearing a non-existent blocker id is a no-op (still returns the objective)", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    store.addBlocker(TID, { reason: "r", waitingOn: "user" })
    const res = store.clearBlocker(TID, "does-not-exist")
    expect(res).not.toBeNull()
    expect(res?.blockers).toHaveLength(1)
    expect(res?.status).toBe("blocked")
  })

  test("two blockers; clearing one keeps blocked until both cleared", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
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
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["x", "y"] })
    const idX = obj.successCriteria[0]?.id ?? ""
    const idY = obj.successCriteria[1]?.id ?? ""
    expect(store.markCriterion(TID, idX, true)?.status).toBe("active")
    expect(store.markCriterion(TID, idY, true)?.status).toBe("completed")
  })

  test("with zero criteria, completion is NOT auto-derived (vacuous truth rejected)", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    expect(store.get(TID)?.status).toBe("active")
  })

  test("unmarking a criterion reverts 'completed' back to active", () => {
    const store = freshStore()
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
    const id = obj.successCriteria[0]?.id ?? ""
    expect(store.markCriterion(TID, id, true)?.status).toBe("completed")
    expect(store.markCriterion(TID, id, false)?.status).toBe("active")
  })

  test("a blocker SUPPRESSES auto-completion even when all criteria are met", () => {
    const store = freshStore()
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
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
    seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
    const res = store.markCriterion(TID, "ghost", true)
    expect(res).not.toBeNull()
    expect(res?.successCriteria.every((c) => c.met === false)).toBe(true)
    expect(res?.status).toBe("active")
  })
})

// GOAL-01: `recordUsage` (self-reported) is gone. Usage reaches the objective
// ONLY through a host-measured `settleAttempt`, which debits at most ONE turn.
describe("HELLGATE [ADR-0394] — host-settled usage accumulation", () => {
  test("tokens and turns accumulate across settlements", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g", budget: { maxTokens: 100, maxTurns: 5 } })
    settleUsage(store, TID, { tokens: 30 })
    settleTurns(store, TID, 2, 20)
    const settled = settleUsage(store, TID, { turns: 1 })
    expect(settled.ok).toBe(true)
    const obj = store.get(TID)
    expect(obj?.budget.tokensUsed).toBe(50)
    expect(obj?.budget.turnsUsed).toBe(3)
    expect(obj?.budget.maxTokens).toBe(100)
    expect(obj?.budget.maxTurns).toBe(5)
  })

  test("one settlement debits at most ONE turn regardless of the claimed count", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    settleUsage(store, TID, { tokens: 1, turns: 7 })
    expect(store.get(TID)?.budget.turnsUsed).toBe(1)
  })

  test("negative / NaN usage deltas are clamped to a no-op (never decrement)", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    settleTurns(store, TID, 2, 10)
    const settled = settleUsage(store, TID, { tokens: -100, turns: Number.NaN })
    // The settlement itself is admitted (a receipt is still appended)…
    expect(settled.ok).toBe(true)
    // …but the hostile deltas never move the counters backwards.
    const obj = store.get(TID)
    expect(obj?.budget.tokensUsed).toBe(10)
    expect(obj?.budget.turnsUsed).toBe(2)
  })

  test("a settlement does NOT alter status derivation", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g", successCriteria: ["x"] })
    settleUsage(store, TID, { tokens: 1 })
    expect(store.get(TID)?.status).toBe("active")
  })
})

describe("HELLGATE [ADR-0394] — nextActions", () => {
  test("setNextActions replaces (not appends) and freezes the array", () => {
    const store = freshStore()
    seedObjective(store, TID, { goal: "g" })
    store.setNextActions(TID, ["step 1", "step 2"])
    const obj = store.setNextActions(TID, ["only step"])
    expect(obj?.nextActions).toEqual(["only step"])
    expect(Object.isFrozen(obj?.nextActions)).toBe(true)
  })
})

describe("HELLGATE [ADR-0394] — snapshot round-trip", () => {
  test("toSnapshot → fromSnapshot reproduces an identical store (deep-equal)", () => {
    const store = freshStore(777)
    seedObjective(store, "t1", { goal: "first", successCriteria: ["a"], budget: { maxTokens: 50 } })
    seedObjective(store, "t2", { goal: "second" })
    store.addBlocker("t2", { reason: "wait", waitingOn: "user" })
    settleUsage(store, "t1", { tokens: 7, turns: 1 })
    const snap = store.toSnapshot()

    const restored = freshStore(999)
    restored.fromSnapshot(snap)
    expect(restored.toSnapshot()).toEqual(snap)
    expect(restored.get("t1")?.goal).toBe("first")
    expect(restored.get("t2")?.status).toBe("blocked")
    expect(restored.get("t1")?.budget.tokensUsed).toBe(7)
    // GOAL-01: the generation identity survives the round-trip verbatim and is
    // NOT re-tagged as a legacy migration.
    expect(restored.get("t1")?.objectiveId).toBe(store.get("t1")?.objectiveId ?? "")
    expect(restored.get("t1")?.createdBy).toBe("system")
    expect(restored.get("t1")?.migrationSource).toBeUndefined()
  })

  test("snapshot serializes byte-stable through JSON", () => {
    const store = freshStore(1)
    seedObjective(store, "t1", { goal: "g", successCriteria: ["a", "b"] })
    const snap = store.toSnapshot()
    const round = JSON.parse(JSON.stringify(snap)) as ObjectiveSnapshot
    const restored = freshStore(2)
    restored.fromSnapshot(round)
    expect(JSON.stringify(restored.toSnapshot())).toBe(JSON.stringify(snap))
  })

  test("fromSnapshot REPLACES prior state (does not merge)", () => {
    const store = freshStore()
    seedObjective(store, "old", { goal: "old goal" })
    const empty: ObjectiveSnapshot = { objectives: [] }
    store.fromSnapshot(empty)
    expect(store.get("old")).toBeNull()
    expect(store.list()).toHaveLength(0)
  })
})

describe("HELLGATE [ADR-0394] — NO-THROW on malformed / hostile input", () => {
  test("create tolerates malformed definition without throwing", () => {
    const store = freshStore()
    expect(() =>
      store.create(TID, {
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
    expect(() => store.create(bad, { goal: "g" })).not.toThrow()
    expect(() => store.replace(bad, { goal: "g" })).not.toThrow()
    expect(() => store.clear(bad)).not.toThrow()
    expect(() => store.setExplicitStatus(bad, "active")).not.toThrow()
    expect(() => store.amendBudget(bad, { maxTokens: 1 })).not.toThrow()
    expect(() => store.addBlocker(bad, { reason: "r", waitingOn: "user" })).not.toThrow()
    expect(() => store.clearBlocker(bad, "x")).not.toThrow()
    expect(() => store.setNextActions(bad, [])).not.toThrow()
    expect(() => store.markCriterion(bad, "x", true)).not.toThrow()
    expect(() => store.markUsageLimited(bad, 1)).not.toThrow()
    expect(() => settleUsage(store, bad, {})).not.toThrow()
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

  // GOAL-01 (REVERSED): an empty goal used to be accepted as a "usable"
  // objective. The domain now owns goal validity — an empty goal is REFUSED
  // (null, nothing minted) without throwing, and so is a goal over the ceiling.
  test("an empty-goal create is refused (null, no throw, nothing minted)", () => {
    const store = freshStore()
    expect(() => store.create(TID, { goal: "" })).not.toThrow()
    expect(store.create(TID, { goal: "" })).toBeNull()
    expect(store.get(TID)).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  test("goal length is bounded by MAX_GOAL_CHARS: at the cap ok, over the cap refused", () => {
    const store = freshStore()
    expect(store.create("over", { goal: "a".repeat(MAX_GOAL_CHARS + 1) })).toBeNull()
    expect(store.get("over")).toBeNull()
    expect(store.create("at", { goal: "a".repeat(MAX_GOAL_CHARS) })?.goal.length).toBe(
      MAX_GOAL_CHARS,
    )
    // replace enforces the same ceiling and leaves the live generation intact.
    const before = store.get("at")?.objectiveId ?? ""
    store.replace("at", { goal: "a".repeat(MAX_GOAL_CHARS + 1) })
    expect(store.get("at")?.objectiveId).toBe(before)
    expect(store.get("at")?.goal.length).toBe(MAX_GOAL_CHARS)
  })

  // Documented contract (`ObjectivePort.replace`, src/objective/types.ts): "null
  // when … the definition is malformed". Same refused-outcome projection as the
  // `create` case above — GREEN since GOAL-02 (used to be kept RED on purpose).
  test("replace with an over-cap goal returns null (port contract)", () => {
    const store = freshStore()
    seedObjective(store, "at", { goal: "ok" })
    expect(store.replace("at", { goal: "a".repeat(MAX_GOAL_CHARS + 1) })).toBeNull()
  })
})

describe("HELLGATE [ADR-0394] — multi-thread isolation", () => {
  test("mutating one thread never touches a sibling thread", () => {
    const store = freshStore()
    seedObjective(store, "a", { goal: "A", successCriteria: ["a1"] })
    seedObjective(store, "b", { goal: "B", successCriteria: ["b1"] })
    store.addBlocker("a", { reason: "r", waitingOn: "user" })
    settleUsage(store, "a", { tokens: 99 })

    const b = store.get("b")
    expect(b?.status).toBe("active")
    expect(b?.blockers).toHaveLength(0)
    expect(b?.budget.tokensUsed).toBe(0)
    expect(b?.goal).toBe("B")
  })

  test("list returns all objectives independently", () => {
    const store = freshStore()
    seedObjective(store, "a", { goal: "A" })
    seedObjective(store, "b", { goal: "B" })
    seedObjective(store, "c", { goal: "C" })
    const goals = store
      .list()
      .map((o: Objective) => o.goal)
      .sort()
    expect(goals).toEqual(["A", "B", "C"])
  })

  test("the snapshot from list() is a defensive copy (mutating it cannot corrupt the store)", () => {
    const store = freshStore()
    seedObjective(store, "a", { goal: "A" })
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
    const created = seedObjective(store, TID, { goal: "g" })
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
    const obj = seedObjective(store, TID, { goal: "g" })
    const after = Date.now()
    expect(obj.createdAt).toBeGreaterThanOrEqual(before)
    expect(obj.createdAt).toBeLessThanOrEqual(after)
  })

  // Audit R2 (F3): bounded growth defensive caps. The agent populates its own
  // threads, but a pathological loop could otherwise grow these unbounded.
  test("successCriteria capped at MAX_CRITERIA_PER_OBJECTIVE (256) — extras dropped", () => {
    const store = createObjectiveStore({ now: () => 1000 })
    const huge = Array.from({ length: 300 }, (_, i) => `criterion-${i}`)
    const obj = seedObjective(store, TID, { goal: "g", successCriteria: huge })
    expect(obj.successCriteria.length).toBe(256)
    expect(obj.successCriteria[0]?.text).toBe("criterion-0")
    expect(obj.successCriteria[255]?.text).toBe("criterion-255")
  })

  test("addBlocker capped at MAX_BLOCKERS_PER_OBJECTIVE (64) — extras silently dropped", () => {
    const store = createObjectiveStore({ now: () => 1000 })
    seedObjective(store, TID, { goal: "g" })
    for (let i = 0; i < 80; i++) {
      store.addBlocker(TID, { reason: `blk-${i}`, waitingOn: "user" })
    }
    const obj = store.get(TID)
    expect(obj?.blockers.length).toBe(64)
    expect(obj?.blockers[0]?.reason).toBe("blk-0")
    expect(obj?.blockers[63]?.reason).toBe("blk-63")
  })
})

/**
 * R4 audit-M — objective snapshot reapply caps.
 *
 * Pre-fix: the live `sanitizeCriteria` path in `src/objective/store.ts`
 * enforces `MAX_CRITERIA_PER_OBJECTIVE = 256` and `MAX_BLOCKERS_PER_OBJECTIVE
 * = 64` on the `set()` / `addBlocker()` paths. The snapshot rebuild path
 * (`fromSnapshot` → `cellFromObjective` → `rebuildCriteria` /
 * `rebuildBlockers`) bypassed those caps. A hostile/corrupted snapshot
 * shipping a 1 000 000-entry `successCriteria` array could:
 *   - inflate in-memory cell beyond the live-cap design intent
 *   - violate the `addBlocker` "silently drop the 65th" invariant in
 *     reverse — every subsequent `addBlocker` becomes a no-op because the
 *     count already exceeds the cap
 *   - skew status derivation (`blockers.length > 0` → status "blocked"
 *     forever)
 *
 * Post-fix `rebuildCriteria`/`rebuildBlockers` reapply the same caps —
 * silently truncating instead of throwing (matches the live path's
 * "drop-on-overflow" discipline).
 *
 * Five cases:
 *   (1) snapshot with 1000 criteria — rebuild caps at 256, no throw
 *   (2) snapshot with 1000 blockers — rebuild caps at 64
 *   (3) under-cap healthy snapshot (200 crit / 30 block) — exact round-trip
 *   (4) cap-boundary snapshot (256 crit / 64 block) — accepted in full
 *   (5) addBlocker after a hostile 65-blocker rebuild still rejects
 *       (downstream invariant preserved)
 *
 * Replaying against a pre-fix tree (rebuild without caps) MUST flip (1)(2)
 * RED — that's the revert proof.
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveStore } from "@/objective"

const makeCriterion = (i: number) => ({
  id: `c-${i}`,
  text: `criterion ${i}`,
  met: false,
  kind: "manual" as const,
})
const makeBlocker = (i: number) => ({
  id: `b-${i}`,
  reason: `blocker ${i}`,
  waitingOn: "user" as const,
  since: 1_000_000 + i,
})

describe("R4 audit-M — objective snapshot reapply caps", () => {
  test("(1) hostile 1000-criterion snapshot rebuilds to ≤ 256 silently", () => {
    const store = createObjectiveStore()
    const objectives = [
      {
        threadId: "t1",
        objectiveId: "obj-t1",
        createdBy: "system" as const,
        goal: "g",
        successCriteria: Array.from({ length: 1000 }, (_, i) => makeCriterion(i)),
        status: "active" as const,
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: [],
        nextActions: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    expect(() => store.fromSnapshot({ objectives })).not.toThrow()
    const got = store.get("t1")
    expect(got).not.toBeNull()
    expect(got?.successCriteria.length).toBe(256)
  })

  test("(2) hostile 1000-blocker snapshot rebuilds to ≤ 64 silently", () => {
    const store = createObjectiveStore()
    const objectives = [
      {
        threadId: "t2",
        objectiveId: "obj-t2",
        createdBy: "system" as const,
        goal: "g",
        successCriteria: [],
        status: "blocked" as const,
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: Array.from({ length: 1000 }, (_, i) => makeBlocker(i)),
        nextActions: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    expect(() => store.fromSnapshot({ objectives })).not.toThrow()
    const got = store.get("t2")
    expect(got).not.toBeNull()
    expect(got?.blockers.length).toBe(64)
    // Derived status is still "blocked" (blockers.length > 0)
    expect(got?.status).toBe("blocked")
  })

  test("(3) healthy under-cap snapshot round-trips exactly", () => {
    const store = createObjectiveStore()
    const objectives = [
      {
        threadId: "t3",
        objectiveId: "obj-t3",
        createdBy: "system" as const,
        goal: "g",
        successCriteria: Array.from({ length: 200 }, (_, i) => makeCriterion(i)),
        status: "active" as const,
        budget: { tokensUsed: 100, turnsUsed: 5 },
        blockers: Array.from({ length: 30 }, (_, i) => makeBlocker(i)),
        nextActions: ["next"],
        createdAt: 100,
        updatedAt: 200,
      },
    ]
    store.fromSnapshot({ objectives })
    const got = store.get("t3")
    expect(got?.successCriteria.length).toBe(200)
    expect(got?.blockers.length).toBe(30)
    // GOAL-01: a snapshot that already carries its generation identity keeps
    // it verbatim (no legacy re-tagging on the healthy path).
    expect(got?.objectiveId).toBe("obj-t3")
    expect(got?.createdBy).toBe("system")
    expect(got?.migrationSource).toBeUndefined()
  })

  test("(4) cap-boundary snapshot (256 / 64) accepted in full", () => {
    const store = createObjectiveStore()
    const objectives = [
      {
        threadId: "t4",
        objectiveId: "obj-t4",
        createdBy: "system" as const,
        goal: "g",
        successCriteria: Array.from({ length: 256 }, (_, i) => makeCriterion(i)),
        status: "active" as const,
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: Array.from({ length: 64 }, (_, i) => makeBlocker(i)),
        nextActions: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    store.fromSnapshot({ objectives })
    const got = store.get("t4")
    expect(got?.successCriteria.length).toBe(256)
    expect(got?.blockers.length).toBe(64)
  })

  test("(5) downstream addBlocker still rejects past 64 after capped rebuild", () => {
    // After (2)'s clamping to 64, the live addBlocker path STILL enforces the
    // 64-cap (`cell.blockers.length >= MAX_BLOCKERS_PER_OBJECTIVE` → silently
    // drop). The invariant survives a hostile-snapshot reload.
    const store = createObjectiveStore()
    store.fromSnapshot({
      objectives: [
        {
          threadId: "t5",
          objectiveId: "obj-t5",
          createdBy: "system" as const,
          goal: "g",
          successCriteria: [],
          status: "blocked" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: Array.from({ length: 1000 }, (_, i) => makeBlocker(i)),
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const before = store.get("t5")?.blockers.length
    expect(before).toBe(64)
    store.addBlocker("t5", { reason: "extra", waitingOn: "user" })
    const after = store.get("t5")?.blockers.length
    expect(after).toBe(64) // still 64 — the 65th is silently dropped
  })
})

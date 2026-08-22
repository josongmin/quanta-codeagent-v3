/**
 * Focus-chain ⇆ plan bridge (the missing wire — ADR-0219 / ADR-0095).
 *
 * The Cline-absorption focus-chain tracker re-injects todos every N turns, but
 * NOTHING in production fed it: the plan tool writes `planStore`, the tracker
 * is separate, and the only prod `setTodos` call site cleared to `[]`. This
 * bridge is the one place the two meet — it maps the producer `Plan` onto
 * `FocusTodo[]` and syncs the tracker, but ONLY when the plan actually changed
 * (so the drift detector still fires when the model stops touching its plan).
 *
 * PURE — no loop, no IO. Drives the bridge functions directly.
 */
import { describe, expect, test } from "bun:test"
import { defaultFocusChainTracker } from "@/agent/focus-chain"
import { planToFocusTodos, syncFocusChainFromPlan } from "@/agent/focus-chain/plan-bridge"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"

let clock = 1000
const store = (): PlanStore => createInMemoryPlanStore({ now: () => ++clock })

// Valid transition paths from the create-default `pending` (transitions.ts):
//   pending→in_progress→completed, pending→cancelled, pending→blocked.
const PATH: Record<string, readonly string[]> = {
  pending: [],
  in_progress: ["in_progress"],
  completed: ["in_progress", "completed"],
  cancelled: ["cancelled"],
  blocked: ["blocked"],
}

const mk = (
  todos: ReadonlyArray<{ content: string; status?: string }>,
): ReturnType<PlanStore["current"]> => {
  const s = store()
  s.create({ name: "p", overview: "o", todos: todos.map((t) => ({ content: t.content })) })
  const plan = s.current()
  if (plan === null) throw new Error("plan create failed")
  const ids = Object.values(plan.todos)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((t) => t.id)
  // Walk each todo through a VALID transition path one step at a time (atomic
  // batches reject if ANY single transition is illegal — e.g. pending→completed).
  todos.forEach((t, i) => {
    for (const step of PATH[t.status ?? "pending"] ?? []) {
      const v = s.current()?.version ?? 0
      const r = s.updateTodos([{ id: ids[i] as string, status: step as never }], true, v)
      if (!r.ok) throw new Error(`bad transition ${t.content}→${step}: ${JSON.stringify(r.error)}`)
    }
  })
  return s.current()
}

describe("planToFocusTodos — mapping + ordering", () => {
  test("null plan ⇒ empty list", () => {
    expect(planToFocusTodos(null)).toEqual([])
  })

  test("status mapping covers all 5 TodoStatus arms", () => {
    const plan = mk([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d", status: "cancelled" },
      { content: "e", status: "blocked" },
    ])
    const got = planToFocusTodos(plan)
    const byText = Object.fromEntries(got.map((t) => [t.text, t.state]))
    expect(byText.a).toBe("pending")
    expect(byText.b).toBe("in-progress")
    expect(byText.c).toBe("done")
    expect(byText.d).toBe("done") // cancelled is terminal → done (lossy, documented)
    expect(byText.e).toBe("pending") // blocked is still open → pending
  })

  test("deterministic order: by createdAt then id (insertion order preserved)", () => {
    const plan = mk([{ content: "first" }, { content: "second" }, { content: "third" }])
    expect(planToFocusTodos(plan).map((t) => t.text)).toEqual(["first", "second", "third"])
  })
})

describe("syncFocusChainFromPlan — change-gated sync (drift-preserving)", () => {
  test("changed plan ⇒ setTodos fires, returns true, tracker reflects the plan", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    const plan = mk([{ content: "x" }, { content: "y" }])
    const changed = syncFocusChainFromPlan(tracker, plan)
    expect(changed).toBe(true)
    expect(tracker.snapshotTodos().map((t) => t.text)).toEqual(["x", "y"])
  })

  test("identical plan twice ⇒ second sync is a no-op (returns false) — drift NOT reset", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 99, driftWindowTurns: 3 })
    const plan = mk([{ content: "x" }])
    expect(syncFocusChainFromPlan(tracker, plan)).toBe(true) // activity at turn 0

    // Tick past the drift window WITHOUT changing the plan. If the second sync
    // wrongly called setTodos each tick it would reset activity → never drift.
    for (let i = 0; i < 4; i++) {
      tracker.tickTurn()
      expect(syncFocusChainFromPlan(tracker, plan)).toBe(false) // unchanged ⇒ no-op
    }
    expect(tracker.getDriftWarning()).not.toBeNull() // drift survived the no-op syncs
  })

  test("a real status change between syncs ⇒ detected (returns true)", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    const p1 = mk([{ content: "x", status: "pending" }])
    syncFocusChainFromPlan(tracker, p1)
    const p2 = mk([{ content: "x", status: "in_progress" }])
    expect(syncFocusChainFromPlan(tracker, p2)).toBe(true)
    expect(tracker.snapshotTodos()[0]?.state).toBe("in-progress")
  })

  test("plan dropped (null) while tracker non-empty ⇒ clears, returns true", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    syncFocusChainFromPlan(tracker, mk([{ content: "x" }]))
    expect(syncFocusChainFromPlan(tracker, null)).toBe(true)
    expect(tracker.snapshotTodos().length).toBe(0)
  })

  test("null plan + empty tracker ⇒ no-op (returns false)", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    expect(syncFocusChainFromPlan(tracker, null)).toBe(false)
  })
})

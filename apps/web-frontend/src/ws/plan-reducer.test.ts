import { describe, expect, it } from "vitest"
import type { AgentStatePlan, AgentStatePlanDelta } from "../types/protocol"
import { applyPlanDelta } from "./plan-reducer"

const plan = (over: Partial<AgentStatePlan> = {}): AgentStatePlan => ({
  id: "p1",
  name: "Plan",
  version: 1,
  todos: [
    { id: "t1", title: "first", status: "pending" },
    { id: "t2", title: "second", status: "in_progress" },
  ],
  ...over,
})

// `plan.created` / `plan.snapshot` deliver the FULL plan; this reducer only
// folds the incremental `plan.updated` delta. The created→updated path is the
// happy line.
describe("applyPlanDelta — created→updated applies", () => {
  it("folds a delta onto an existing plan and stamps version", () => {
    const next = applyPlanDelta(
      plan(),
      { kind: "todo_status_changed", todoId: "t1", toStatus: "completed" },
      2,
    )
    expect(next?.version).toBe(2)
    expect(next?.todos.find((t) => t.id === "t1")?.status).toBe("completed")
    // untouched todo preserved
    expect(next?.todos.find((t) => t.id === "t2")?.status).toBe("in_progress")
  })
})

// OUT-OF-ORDER SAFETY — a delta that lands before its plan snapshot is a no-op.
describe("applyPlanDelta — updated-before-created no-ops", () => {
  it("returns null unchanged when there is no current plan", () => {
    const delta: AgentStatePlanDelta = {
      kind: "todo_status_changed",
      todoId: "t1",
      toStatus: "completed",
    }
    expect(applyPlanDelta(null, delta, 5)).toBeNull()
  })
})

describe("applyPlanDelta — each delta kind", () => {
  it("todo_added appends a fresh pending todo", () => {
    const next = applyPlanDelta(plan(), { kind: "todo_added", todoId: "t3", todoTitle: "third" }, 2)
    expect(next?.todos).toHaveLength(3)
    const added = next?.todos.find((t) => t.id === "t3")
    expect(added?.title).toBe("third")
    expect(added?.status).toBe("pending")
    expect(next?.version).toBe(2)
  })

  it("todo_added on an existing id does not duplicate (version only)", () => {
    const next = applyPlanDelta(plan(), { kind: "todo_added", todoId: "t1", todoTitle: "dupe" }, 2)
    expect(next?.todos).toHaveLength(2)
    expect(next?.todos.find((t) => t.id === "t1")?.title).toBe("first")
    expect(next?.version).toBe(2)
  })

  it("todo_removed drops the matching todo", () => {
    const next = applyPlanDelta(plan(), { kind: "todo_removed", todoId: "t1" }, 2)
    expect(next?.todos).toHaveLength(1)
    expect(next?.todos[0]?.id).toBe("t2")
    expect(next?.version).toBe(2)
  })

  it("todo_status_changed sets the new status", () => {
    const next = applyPlanDelta(
      plan(),
      { kind: "todo_status_changed", todoId: "t2", toStatus: "blocked" },
      3,
    )
    expect(next?.todos.find((t) => t.id === "t2")?.status).toBe("blocked")
    expect(next?.version).toBe(3)
  })

  it("todo_renamed sets the new title via toName", () => {
    const next = applyPlanDelta(
      plan(),
      { kind: "todo_renamed", todoId: "t1", fromName: "first", toName: "FIRST!" },
      4,
    )
    expect(next?.todos.find((t) => t.id === "t1")?.title).toBe("FIRST!")
    // status preserved on a rename
    expect(next?.todos.find((t) => t.id === "t1")?.status).toBe("pending")
    expect(next?.version).toBe(4)
  })

  it("plan_renamed sets the plan name via toName", () => {
    const next = applyPlanDelta(
      plan(),
      { kind: "plan_renamed", fromName: "Plan", toName: "Renamed Plan" },
      5,
    )
    expect(next?.name).toBe("Renamed Plan")
    expect(next?.todos).toHaveLength(2)
    expect(next?.version).toBe(5)
  })
})

// Defensive no-ops: an unknown todo id / missing required field advances the
// version but never throws and never mutates the todo list.
describe("applyPlanDelta — defensive no-ops", () => {
  it("unknown todo id on a status change leaves todos untouched (version bumps)", () => {
    const before = plan()
    const next = applyPlanDelta(
      before,
      { kind: "todo_status_changed", todoId: "ghost", toStatus: "completed" },
      2,
    )
    expect(next?.todos).toEqual(before.todos)
    expect(next?.version).toBe(2)
  })

  it("todo_added missing todoTitle is a no-op on the list (version bumps)", () => {
    const next = applyPlanDelta(plan(), { kind: "todo_added", todoId: "t3" }, 2)
    expect(next?.todos).toHaveLength(2)
    expect(next?.version).toBe(2)
  })

  it("todo_removed missing todoId is a no-op on the list (version bumps)", () => {
    const next = applyPlanDelta(plan(), { kind: "todo_removed" }, 2)
    expect(next?.todos).toHaveLength(2)
    expect(next?.version).toBe(2)
  })

  it("plan_renamed missing toName leaves the name (version bumps)", () => {
    const next = applyPlanDelta(plan(), { kind: "plan_renamed", fromName: "Plan" }, 2)
    expect(next?.name).toBe("Plan")
    expect(next?.version).toBe(2)
  })

  it("does not mutate the input plan (immutability)", () => {
    const before = plan()
    const snapshot = JSON.stringify(before)
    applyPlanDelta(before, { kind: "todo_removed", todoId: "t1" }, 2)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

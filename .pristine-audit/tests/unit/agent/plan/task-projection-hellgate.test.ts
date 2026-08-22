/**
 * RFC07-3 hellgate — pure `projectPlanTasks(plan)` read projection.
 *
 * Canonical mapping (Claude-compatible read alias, NOT a stored field):
 *   owner     := todo.assignee                       (omitted when absent)
 *   blockedBy := todo.dependencies                   (canonical inbound edge)
 *   blocks(A) := all todo ids B where A ∈ B.dependencies (reverse edge)
 *
 * Determinism contract: canonical todo order is (`createdAt`, then `id`); every
 * projected edge array follows that same order. Object insertion order must be
 * irrelevant.
 *
 * This is a PURE-LEAF gate. The front-door (`current_plan`) rail lives in
 * `tests/unit/tool/plan/current-plan-task-projection-hellgate.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { projectPlanTasks } from "../../../../src/agent/plan/task-projection"
import type { NewTodo, Plan, TodoItem, TodoPatch } from "../../../../src/agent/plan/types"

// ── Structural guard: owner/blockedBy/blocks are NOT write vocabulary ────────
// The canonical write shapes accept only `assignee` + `dependencies`. If a
// future edit introduced a stored `owner`/`blockedBy`/`blocks` field on the
// mutation inputs, these `@ts-expect-error` lines would stop erroring and the
// typecheck rail (bun run typecheck) would fail — proving the projection stays
// a pure read alias with no second owner field / reverse edge storage.
const _rejectStoredNewTodo: NewTodo = {
  content: "x",
  // @ts-expect-error owner is not an accepted mutation field (use assignee)
  owner: "tester",
}
const _rejectStoredNewTodoBlocks: NewTodo = {
  content: "x",
  // @ts-expect-error blocks is a derived read edge, never a write field
  blocks: ["y"],
}
const _rejectStoredPatch: TodoPatch = {
  id: "a",
  // @ts-expect-error blockedBy is a read alias for dependencies, never a write field
  blockedBy: ["b"],
}
// Reference the bindings so they are not tree-shaken / flagged unused.
void _rejectStoredNewTodo
void _rejectStoredNewTodoBlocks
void _rejectStoredPatch

const todo = (
  id: string,
  createdAt: number,
  deps: readonly string[],
  assignee?: string,
): TodoItem => ({
  id,
  content: `content ${id}`,
  status: "pending",
  createdAt,
  updatedAt: createdAt,
  dependencies: deps,
  ...(assignee !== undefined ? { assignee } : {}),
})

const planFrom = (todos: readonly TodoItem[]): Plan => {
  const record: Record<string, TodoItem> = {}
  for (const t of todos) record[t.id] = t
  return {
    version: 1,
    name: "p",
    overview: "o",
    isProject: false,
    todos: record,
    phases: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("RFC07-3 projectPlanTasks — canonical reverse-edge projection", () => {
  test("A, B→A, C→A+B yields A.blocks=[B,C], B.blocks=[C], C.blocks=[]", () => {
    const plan = planFrom([todo("A", 1, []), todo("B", 2, ["A"]), todo("C", 3, ["A", "B"])])
    const tasks = projectPlanTasks(plan)
    const byId = new Map(tasks.map((t) => [t.id, t]))

    expect(byId.get("A")?.blocks).toEqual(["B", "C"])
    expect(byId.get("B")?.blocks).toEqual(["C"])
    expect(byId.get("C")?.blocks).toEqual([])

    // blockedBy is the canonical inbound edge, verbatim from dependencies.
    expect(byId.get("A")?.blockedBy).toEqual([])
    expect(byId.get("B")?.blockedBy).toEqual(["A"])
    expect(byId.get("C")?.blockedBy).toEqual(["A", "B"])
  })

  test("assignee renders owner; absent assignee omits the field entirely", () => {
    const plan = planFrom([todo("A", 1, [], "tester"), todo("B", 2, ["A"])])
    const tasks = projectPlanTasks(plan)
    const a = tasks.find((t) => t.id === "A")
    const b = tasks.find((t) => t.id === "B")

    expect(a?.owner).toBe("tester")
    // Absent assignee ⇒ `owner` key MUST NOT be present (not undefined-valued).
    expect(b !== undefined && "owner" in b).toBe(false)
  })

  test("object insertion order cannot change output ordering — sorted by createdAt then id", () => {
    // Same graph, opposite insertion order → identical projection.
    const forward = projectPlanTasks(
      planFrom([todo("A", 1, []), todo("B", 2, ["A"]), todo("C", 3, ["A", "B"])]),
    )
    const reversed = projectPlanTasks(
      planFrom([todo("C", 3, ["A", "B"]), todo("B", 2, ["A"]), todo("A", 1, [])]),
    )
    expect(reversed).toEqual(forward)
    expect(forward.map((t) => t.id)).toEqual(["A", "B", "C"])
  })

  test("createdAt ties break by id (deterministic, canonical)", () => {
    const tasks = projectPlanTasks(planFrom([todo("z", 5, []), todo("a", 5, []), todo("m", 5, [])]))
    expect(tasks.map((t) => t.id)).toEqual(["a", "m", "z"])
  })

  test("reverse-edge (blocks) arrays follow the same canonical order", () => {
    // X blocks Y and Z; Z has an earlier createdAt than Y, so blocks must list Z before Y.
    const plan = planFrom([todo("X", 1, []), todo("Y", 3, ["X"]), todo("Z", 2, ["X"])])
    const x = projectPlanTasks(plan).find((t) => t.id === "X")
    expect(x?.blocks).toEqual(["Z", "Y"])
  })

  test("empty blockedBy/blocks are explicit empty arrays, never undefined", () => {
    const only = projectPlanTasks(planFrom([todo("solo", 1, [])]))[0]
    expect(only?.blockedBy).toEqual([])
    expect(only?.blocks).toEqual([])
  })
})

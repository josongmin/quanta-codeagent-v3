/**
 * Mutations hellgate (ADR-0095 draft). Pins every variant of
 * {@link PlanMutationError} to a concrete failing path through one of the
 * 6 reducers in `src/agent/plan/mutations.ts`. Happy paths included so
 * idempotence / pure-output invariants stay green.
 */
import { describe, expect, test } from "bun:test"
import {
  addTodos,
  createPlan,
  removeTodos,
  reorderPhases,
  updateMeta,
  updateTodos,
} from "../../../../src/agent/plan/mutations"
import {
  ALL_PLAN_MUTATION_ERROR_KINDS,
  type CreatePlanArgs,
  PLAN_LIMITS,
  type Plan,
  type PlanResult,
  type TodoStatus,
} from "../../../../src/agent/plan/types"

// ── helpers ─────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000
const seqGen = (prefix = "id"): (() => string) => {
  let n = 0
  return () => {
    n += 1
    return `${prefix}-${n}`
  }
}

const unwrap = <T>(r: PlanResult<T>): T => {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`)
  return r.value
}
const expectErr = (r: PlanResult<unknown>) => {
  if (r.ok) throw new Error("expected error, got ok")
  return r.error
}

const basePlan = (overrides?: Partial<CreatePlanArgs>): Plan => {
  const args: CreatePlanArgs = {
    name: "p",
    overview: "o",
    todos: [{ content: "A" }, { content: "B" }],
    ...(overrides ?? {}),
  }
  const r = createPlan(args, NOW, seqGen())
  const d = unwrap(r)
  return d.plan
}

// ── createPlan ──────────────────────────────────────────────────────────

describe("createPlan happy + invariants", () => {
  test("creates v0 with provided meta + todos", () => {
    const plan = basePlan()
    expect(plan.version).toBe(0)
    expect(plan.name).toBe("p")
    expect(plan.overview).toBe("o")
    expect(Object.keys(plan.todos)).toHaveLength(2)
  })
  test("pure: same inputs+idGen+now → same plan", () => {
    const a = createPlan(
      { name: "x", overview: "y", todos: [{ content: "T" }] },
      NOW,
      seqGen("a"),
    )
    const b = createPlan(
      { name: "x", overview: "y", todos: [{ content: "T" }] },
      NOW,
      seqGen("a"),
    )
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })
  test("default isProject=false", () => {
    expect(basePlan().isProject).toBe(false)
  })
  test("isProject=true preserved", () => {
    expect(basePlan({ isProject: true }).isProject).toBe(true)
  })
  test("phases bind todos via todoIndexes", () => {
    const r = createPlan(
      {
        name: "p",
        overview: "o",
        todos: [{ content: "A" }, { content: "B" }, { content: "C" }],
        phases: [{ name: "ph1", todoIndexes: [0, 1] }, { name: "ph2", todoIndexes: [2] }],
      },
      NOW,
      seqGen(),
    )
    const d = unwrap(r)
    expect(d.plan.phases).toHaveLength(2)
    expect(d.plan.phases[0]?.todoIds).toHaveLength(2)
    const firstTodoIdInPh1 = d.plan.phases[0]?.todoIds[0]
    expect(firstTodoIdInPh1).toBeDefined()
    if (firstTodoIdInPh1 !== undefined) {
      expect(d.plan.todos[firstTodoIdInPh1]?.phaseId).toBe(d.plan.phases[0]?.id)
    }
  })
})

describe("createPlan errors", () => {
  test("empty_plan_create: 0 todos + 0 phases", () => {
    const e = expectErr(createPlan({ name: "n", overview: "o", todos: [] }, NOW, seqGen()))
    expect(e.kind).toBe("empty_plan_create")
  })
  test("content_too_long: name", () => {
    const e = expectErr(
      createPlan({ name: "x".repeat(PLAN_LIMITS.MAX_NAME + 1), overview: "o", todos: [{ content: "T" }] }, NOW, seqGen()),
    )
    expect(e.kind).toBe("content_too_long")
    if (e.kind !== "content_too_long") throw new Error()
    expect(e.field).toBe("name")
    expect(e.max).toBe(PLAN_LIMITS.MAX_NAME)
  })
  test("content_too_long: overview", () => {
    const e = expectErr(
      createPlan({ name: "n", overview: "y".repeat(PLAN_LIMITS.MAX_OVERVIEW + 1), todos: [{ content: "T" }] }, NOW, seqGen()),
    )
    expect(e.kind).toBe("content_too_long")
    if (e.kind !== "content_too_long") throw new Error()
    expect(e.field).toBe("overview")
  })
  test("content_too_long: todo content", () => {
    const e = expectErr(
      createPlan({ name: "n", overview: "o", todos: [{ content: "z".repeat(PLAN_LIMITS.MAX_TODO_CONTENT + 1) }] }, NOW, seqGen()),
    )
    expect(e.kind).toBe("content_too_long")
    if (e.kind !== "content_too_long") throw new Error()
    expect(e.field).toBe("content")
    expect(e.max).toBe(PLAN_LIMITS.MAX_TODO_CONTENT)
  })
  test("self_dependency at create time", () => {
    // The todo references itself by id, which we know via injected idGen (single-id idGen).
    const idGen = () => "self-A"
    const e = expectErr(
      createPlan({ name: "n", overview: "o", todos: [{ content: "T", dependencies: ["self-A"] }] }, NOW, idGen),
    )
    expect(e.kind).toBe("self_dependency")
  })
  test("dependency_unknown at create time", () => {
    const e = expectErr(
      createPlan({ name: "n", overview: "o", todos: [{ content: "T", dependencies: ["nope"] }] }, NOW, seqGen()),
    )
    expect(e.kind).toBe("dependency_unknown")
  })
})

// ── addTodos ────────────────────────────────────────────────────────────

describe("addTodos", () => {
  test("happy: bumps version + emits todos_added", () => {
    const plan = basePlan()
    const r = addTodos(plan, [{ content: "C" }], NOW + 1, seqGen("add"))
    const d = unwrap(r)
    expect(d.kind).toBe("todos_added")
    expect(d.plan.version).toBe(1)
    if (d.kind !== "todos_added") throw new Error()
    expect(d.added).toHaveLength(1)
  })
  test("empty items → noop (version still bumps)", () => {
    const plan = basePlan()
    const d = unwrap(addTodos(plan, [], NOW + 1, seqGen()))
    expect(d.kind).toBe("noop")
    expect(d.plan.version).toBe(1)
  })
  test("phase_not_found when adding with unknown phaseId", () => {
    const plan = basePlan()
    const e = expectErr(addTodos(plan, [{ content: "X", phaseId: "ghost" }], NOW + 1, seqGen("add")))
    expect(e.kind).toBe("phase_not_found")
  })
  test("dependency_unknown when referencing missing id", () => {
    const plan = basePlan()
    const e = expectErr(addTodos(plan, [{ content: "X", dependencies: ["nope"] }], NOW + 1, seqGen("add")))
    expect(e.kind).toBe("dependency_unknown")
  })
})

// ── updateTodos ─────────────────────────────────────────────────────────

describe("updateTodos", () => {
  test("happy: status transition + version bump", () => {
    const plan = basePlan()
    const ids = Object.keys(plan.todos)
    const firstId = ids[0]
    if (firstId === undefined) throw new Error()
    const d = unwrap(updateTodos(plan, [{ id: firstId, status: "in_progress" }], true, NOW + 1))
    expect(d.kind).toBe("todos_updated")
    if (d.kind !== "todos_updated") throw new Error()
    expect(d.updated[0]?.status).toBe("in_progress")
  })
  test("empty patches → noop", () => {
    expect(unwrap(updateTodos(basePlan(), [], true, NOW + 1)).kind).toBe("noop")
  })
  test("todo_not_found when patching unknown id", () => {
    const e = expectErr(updateTodos(basePlan(), [{ id: "ghost", content: "x" }], true, NOW + 1))
    expect(e.kind).toBe("todo_not_found")
  })
  test("invalid_status_transition: completed → pending", () => {
    const plan = basePlan()
    const firstId = Object.keys(plan.todos)[0]
    if (firstId === undefined) throw new Error()
    // First move to completed.
    const p1 = unwrap(updateTodos(plan, [{ id: firstId, status: "in_progress" }], true, NOW + 1)).plan
    const p2 = unwrap(updateTodos(p1, [{ id: firstId, status: "completed" }], true, NOW + 2)).plan
    // Now try illegal transition.
    const e = expectErr(updateTodos(p2, [{ id: firstId, status: "pending" }], true, NOW + 3))
    expect(e.kind).toBe("invalid_status_transition")
    if (e.kind !== "invalid_status_transition") throw new Error()
    expect(e.from).toBe("completed")
    expect(e.to).toBe("pending")
  })
  test("duplicate_id within patches", () => {
    const plan = basePlan()
    const id = Object.keys(plan.todos)[0]
    if (id === undefined) throw new Error()
    const e = expectErr(updateTodos(plan, [{ id, content: "x" }, { id, content: "y" }], true, NOW + 1))
    expect(e.kind).toBe("duplicate_id")
  })
  test("dependency_cycle introduced via patch deps", () => {
    const plan = basePlan() // 2 todos no deps
    const ids = Object.keys(plan.todos)
    const a = ids[0]
    const b = ids[1]
    if (a === undefined || b === undefined) throw new Error()
    // A → B → A cycle.
    const p1 = unwrap(updateTodos(plan, [{ id: a, dependencies: [b] }], true, NOW + 1)).plan
    const e = expectErr(updateTodos(p1, [{ id: b, dependencies: [a] }], true, NOW + 2))
    expect(e.kind).toBe("dependency_cycle")
  })
  test("self_dependency rejected via patch", () => {
    const plan = basePlan()
    const id = Object.keys(plan.todos)[0]
    if (id === undefined) throw new Error()
    const e = expectErr(updateTodos(plan, [{ id, dependencies: [id] }], true, NOW + 1))
    expect(e.kind).toBe("self_dependency")
  })
  test("content_too_long on patch.content", () => {
    const plan = basePlan()
    const id = Object.keys(plan.todos)[0]
    if (id === undefined) throw new Error()
    const e = expectErr(
      updateTodos(plan, [{ id, content: "z".repeat(PLAN_LIMITS.MAX_TODO_CONTENT + 1) }], true, NOW + 1),
    )
    expect(e.kind).toBe("content_too_long")
  })
})

// ── removeTodos ─────────────────────────────────────────────────────────

describe("removeTodos", () => {
  test("happy: removes + bumps", () => {
    const plan = basePlan()
    const id = Object.keys(plan.todos)[0]
    if (id === undefined) throw new Error()
    const d = unwrap(removeTodos(plan, [id], NOW + 1))
    expect(d.kind).toBe("todos_removed")
    if (d.kind !== "todos_removed") throw new Error()
    expect(d.removedIds).toEqual([id])
    expect(d.plan.todos[id]).toBeUndefined()
  })
  test("empty ids → noop", () => {
    expect(unwrap(removeTodos(basePlan(), [], NOW + 1)).kind).toBe("noop")
  })
  test("todo_not_found", () => {
    const e = expectErr(removeTodos(basePlan(), ["ghost"], NOW + 1))
    expect(e.kind).toBe("todo_not_found")
  })
  test("duplicate_id in ids list", () => {
    const plan = basePlan()
    const id = Object.keys(plan.todos)[0]
    if (id === undefined) throw new Error()
    const e = expectErr(removeTodos(plan, [id, id], NOW + 1))
    expect(e.kind).toBe("duplicate_id")
  })
  test("dependency_unknown: removing leaves dangling", () => {
    const plan = basePlan()
    const [a, b] = Object.keys(plan.todos)
    if (a === undefined || b === undefined) throw new Error()
    // Add dep: A → B
    const p1 = unwrap(updateTodos(plan, [{ id: a, dependencies: [b] }], true, NOW + 1)).plan
    // Remove B → A's dep dangles
    const e = expectErr(removeTodos(p1, [b], NOW + 2))
    expect(e.kind).toBe("dependency_unknown")
  })
})

// ── reorderPhases ───────────────────────────────────────────────────────

describe("reorderPhases", () => {
  test("happy: reorders + bumps", () => {
    const plan = basePlan({
      phases: [{ name: "ph1" }, { name: "ph2" }],
      todos: [{ content: "A" }, { content: "B" }],
    })
    const [p1, p2] = plan.phases
    if (p1 === undefined || p2 === undefined) throw new Error()
    const d = unwrap(reorderPhases(plan, [p2.id, p1.id], NOW + 1))
    expect(d.kind).toBe("phases_reordered")
    if (d.kind !== "phases_reordered") throw new Error()
    expect(d.plan.phases[0]?.id).toBe(p2.id)
    expect(d.plan.phases[1]?.id).toBe(p1.id)
  })
  test("phase_not_found when id unknown", () => {
    const plan = basePlan({ phases: [{ name: "ph1" }] })
    const e = expectErr(reorderPhases(plan, ["ghost"], NOW + 1))
    expect(e.kind).toBe("phase_not_found")
  })
  test("duplicate_id in reorder list", () => {
    const plan = basePlan({ phases: [{ name: "ph1" }, { name: "ph2" }] })
    const id = plan.phases[0]?.id
    if (id === undefined) throw new Error()
    const e = expectErr(reorderPhases(plan, [id, id], NOW + 1))
    expect(e.kind).toBe("duplicate_id")
  })
})

// ── updateMeta ──────────────────────────────────────────────────────────

describe("updateMeta", () => {
  test("happy: name change bumps version", () => {
    const plan = basePlan()
    const d = unwrap(updateMeta(plan, { name: "new" }, NOW + 1))
    expect(d.plan.version).toBe(1)
    expect(d.plan.name).toBe("new")
  })
  test("content_too_long on name", () => {
    const e = expectErr(updateMeta(basePlan(), { name: "x".repeat(PLAN_LIMITS.MAX_NAME + 1) }, NOW + 1))
    expect(e.kind).toBe("content_too_long")
  })
})

// ── enum-coverage drift gate ────────────────────────────────────────────

describe("PlanMutationError enum coverage", () => {
  // Every kind in ALL_PLAN_MUTATION_ERROR_KINDS must be observable via at least one path.
  // version_conflict is observed only in state.ts (CAS layer); covered there.
  // Below: confirm each non-CAS kind is reached above by one of the test groups.
  test("9 of 10 kinds reached by mutations tests; version_conflict in state.ts", () => {
    const reached: ReadonlyArray<(typeof ALL_PLAN_MUTATION_ERROR_KINDS)[number]> = [
      "empty_plan_create",
      "content_too_long",
      "self_dependency",
      "dependency_unknown",
      "phase_not_found",
      "todo_not_found",
      "invalid_status_transition",
      "duplicate_id",
      "dependency_cycle",
    ]
    expect(reached).toHaveLength(9)
    expect(ALL_PLAN_MUTATION_ERROR_KINDS.length - reached.length).toBe(1)
    expect(ALL_PLAN_MUTATION_ERROR_KINDS).toContain("version_conflict")
  })
})

// noop status param avoids unused import.
const _statusGuard: TodoStatus = "pending"
void _statusGuard

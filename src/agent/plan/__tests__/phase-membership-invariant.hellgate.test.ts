/**
 * T04 hellgate — `PlanStore` is the SOLE owner of the
 * `todo.phaseId` ↔ `phase.todoIds` bi-directional invariant.
 *
 * Audit refs: L1 H3 / M4 (plan phase membership drift), L2 H3.
 *
 * The store-mutation invariant under proof:
 *
 *   For every plan P produced by ANY reducer/store op:
 *     (a) every `todo.phaseId === ph.id`  ⇒  `ph.todoIds` contains `todo.id`
 *     (b) every id in `ph.todoIds`        ⇒  the todo exists AND its
 *                                            `phaseId === ph.id`
 *     (c) no todo id appears in TWO phases' `todoIds`
 *
 * Before T04 the reducers wrote `todo.phaseId` (add / update) WITHOUT
 * mirroring into `phase.todoIds`, so callers had to compose a second
 * membership-repair mutation. Multi-step composition drifts under partial
 * failure / interleaving. T04 makes the reducer the single owner: every
 * add / update / move / remove keeps BOTH sides consistent atomically.
 */
import { describe, expect, test } from "bun:test"
import { addTodos, createPlan, moveTodo, removeTodos, updateTodos } from "../mutations"
import type { CreatePlanArgs, Plan, PlanResult, TodoItem } from "../types"

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

const planOf = (r: PlanResult): Plan => {
  const v = unwrap(r)
  return v.plan
}

/** The central invariant assertion. Fails LOUD with the offending plan
 *  when ANY of the three membership rules is violated. */
const assertMembershipInvariant = (plan: Plan): void => {
  const todos = plan.todos
  // (a) phaseId points at a real phase that lists this todo.
  for (const todo of Object.values(todos)) {
    if (todo.phaseId === undefined) continue
    const ph = plan.phases.find((p) => p.id === todo.phaseId)
    expect(ph, `todo ${todo.id} points at unknown phase ${todo.phaseId}`).toBeDefined()
    expect(ph?.todoIds.includes(todo.id), `phase ${todo.phaseId} missing member ${todo.id}`).toBe(
      true,
    )
  }
  // (b) every listed member exists + back-points at the phase.
  const seen = new Set<string>()
  for (const ph of plan.phases) {
    for (const tid of ph.todoIds) {
      const todo: TodoItem | undefined = todos[tid]
      expect(todo, `phase ${ph.id} lists missing todo ${tid}`).toBeDefined()
      expect(todo?.phaseId, `todo ${tid} phaseId mismatch in phase ${ph.id}`).toBe(ph.id)
      // (c) no id in two phases.
      expect(seen.has(tid), `todo ${tid} appears in two phases`).toBe(false)
      seen.add(tid)
    }
  }
}

const baseWithPhases = (): Plan => {
  const args: CreatePlanArgs = {
    name: "p",
    overview: "o",
    todos: [{ content: "A" }, { content: "B" }, { content: "C" }],
    phases: [
      { name: "Phase 1", todoIndexes: [0] },
      { name: "Phase 2", todoIndexes: [1] },
    ],
  }
  return planOf(createPlan(args, NOW, seqGen()))
}

describe("T04 — createPlan keeps membership consistent", () => {
  test("phase.todoIds and todo.phaseId agree at birth", () => {
    const plan = baseWithPhases()
    assertMembershipInvariant(plan)
    // todo C (index 2) is unbound — appears in NO phase.
    const cId = Object.values(plan.todos).find((t) => t.content === "C")?.id
    expect(cId).toBeDefined()
    for (const ph of plan.phases) expect(ph.todoIds).not.toContain(cId)
  })
})

describe("T04 — addTodos owns membership (regression: was drift)", () => {
  test("adding a todo WITH phaseId inserts it into that phase.todoIds", () => {
    const plan = baseWithPhases()
    const phase2 = plan.phases[1]
    if (phase2 === undefined) throw new Error("setup")
    const next = planOf(
      addTodos(plan, [{ content: "D", phaseId: phase2.id }], NOW + 1, seqGen("new")),
    )
    assertMembershipInvariant(next)
    const dId = Object.values(next.todos).find((t) => t.content === "D")?.id
    const p2 = next.phases.find((p) => p.id === phase2.id)
    expect(p2?.todoIds).toContain(dId)
  })

  test("adding a todo WITHOUT phaseId leaves all phases unchanged", () => {
    const plan = baseWithPhases()
    const before = plan.phases.map((p) => [...p.todoIds])
    const next = planOf(addTodos(plan, [{ content: "Z" }], NOW + 1, seqGen("z")))
    assertMembershipInvariant(next)
    next.phases.forEach((p, i) => {
      expect([...p.todoIds]).toEqual(before[i] ?? [])
    })
  })
})

describe("T04 — updateTodos owns membership on phaseId change", () => {
  test("changing phaseId MOVES the todo between phases (no drift, no dup)", () => {
    const plan = baseWithPhases()
    const [p1, p2] = plan.phases
    if (p1 === undefined || p2 === undefined) throw new Error("setup")
    const aId = p1.todoIds[0]
    if (aId === undefined) throw new Error("setup")
    const next = planOf(updateTodos(plan, [{ id: aId, phaseId: p2.id }], true, NOW + 1))
    assertMembershipInvariant(next)
    expect(next.phases.find((p) => p.id === p1.id)?.todoIds).not.toContain(aId)
    expect(next.phases.find((p) => p.id === p2.id)?.todoIds).toContain(aId)
  })

  test("clearing phaseId (null sentinel) removes it from every phase", () => {
    const plan = baseWithPhases()
    const p1 = plan.phases[0]
    if (p1 === undefined) throw new Error("setup")
    const aId = p1.todoIds[0]
    if (aId === undefined) throw new Error("setup")
    const next = planOf(updateTodos(plan, [{ id: aId, phaseId: null }], true, NOW + 1))
    assertMembershipInvariant(next)
    expect(next.todos[aId]?.phaseId).toBeUndefined()
    for (const ph of next.phases) expect(ph.todoIds).not.toContain(aId)
  })
})

describe("T04 — moveTodo store op (atomic single-step owner)", () => {
  test("moveTodo binds an unbound todo and lists it once", () => {
    const plan = baseWithPhases()
    const cId = Object.values(plan.todos).find((t) => t.content === "C")?.id
    const p1 = plan.phases[0]
    if (cId === undefined || p1 === undefined) throw new Error("setup")
    const next = planOf(moveTodo(plan, cId, p1.id, NOW + 1))
    assertMembershipInvariant(next)
    expect(next.todos[cId]?.phaseId).toBe(p1.id)
    expect(next.phases.find((p) => p.id === p1.id)?.todoIds).toContain(cId)
  })

  test("moveTodo to null unbinds atomically", () => {
    const plan = baseWithPhases()
    const p1 = plan.phases[0]
    if (p1 === undefined) throw new Error("setup")
    const aId = p1.todoIds[0]
    if (aId === undefined) throw new Error("setup")
    const next = planOf(moveTodo(plan, aId, null, NOW + 1))
    assertMembershipInvariant(next)
    expect(next.todos[aId]?.phaseId).toBeUndefined()
    for (const ph of next.phases) expect(ph.todoIds).not.toContain(aId)
  })

  test("moveTodo to an unknown phase → phase_not_found (no partial mutation)", () => {
    const plan = baseWithPhases()
    const aId = plan.phases[0]?.todoIds[0]
    if (aId === undefined) throw new Error("setup")
    const r = moveTodo(plan, aId, "ghost-phase", NOW + 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("phase_not_found")
  })

  test("moveTodo unknown todo → todo_not_found", () => {
    const plan = baseWithPhases()
    const p1 = plan.phases[0]
    if (p1 === undefined) throw new Error("setup")
    const r = moveTodo(plan, "ghost-todo", p1.id, NOW + 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("todo_not_found")
  })

  test("moveTodo bumps version by exactly 1 and is idempotent in result shape", () => {
    const plan = baseWithPhases()
    const cId = Object.values(plan.todos).find((t) => t.content === "C")?.id
    const p1 = plan.phases[0]
    if (cId === undefined || p1 === undefined) throw new Error("setup")
    const next = planOf(moveTodo(plan, cId, p1.id, NOW + 1))
    expect(next.version).toBe(plan.version + 1)
  })
})

describe("T04 — removeTodos keeps the invariant (existing + reproven)", () => {
  test("removing a bound todo strips it from its phase", () => {
    const plan = baseWithPhases()
    const p1 = plan.phases[0]
    if (p1 === undefined) throw new Error("setup")
    const aId = p1.todoIds[0]
    if (aId === undefined) throw new Error("setup")
    const next = planOf(removeTodos(plan, [aId], NOW + 1))
    assertMembershipInvariant(next)
    for (const ph of next.phases) expect(ph.todoIds).not.toContain(aId)
  })
})

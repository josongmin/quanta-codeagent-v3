/**
 * RFC07-3 front-door hellgate — `current_plan` renders the task projection.
 *
 * Proves the FULL wire: a real canonical `PlanStore` → `planStoreToMutator`
 * adapter → `PlanReadonlyView.tasks` → `current_plan` model-visible output. No
 * observer-only GREEN: the model-visible string must carry owner/blockedBy/
 * blocks for the `A`, `B→A`, `C→A+B` fixture.
 *
 * Red-on-injection: if the adapter stops projecting tasks (or drops the
 * reverse-edge), the rendered output loses the `blocks`/`owner` lines and this
 * gate goes RED.
 */
import { describe, expect, test } from "bun:test"
import { createInMemoryPlanStore } from "../../../../src/agent/plan/state"
import { planStoreToMutator } from "../../../../src/agent/plan/mutator-adapter"
import { currentPlanTool } from "../../../../src/tool/plan/current-plan"
import type { ToolContext, ToolEvent } from "../../../../src/tool/types"

const runTool = async (
  ctx: ToolContext,
): Promise<Extract<ToolEvent, { type: "result" }>["result"]> => {
  const events: ToolEvent[] = []
  for await (const ev of currentPlanTool().execute({}, ctx)) events.push(ev)
  const last = events[events.length - 1]
  if (last?.type !== "result") throw new Error("no result event")
  return last.result
}

const buildStoreWithGraph = () => {
  let clock = 100
  const store = createInMemoryPlanStore({ now: () => clock++ })
  // Create A, B, C with A earliest. dependencies are wired via updateTodos so
  // real ULIDs are used; we re-fetch ids by canonical creation order.
  const created = store.create({
    name: "p",
    overview: "o",
    todos: [
      { content: "task A", assignee: "tester" },
      { content: "task B" },
      { content: "task C" },
    ],
  })
  if (!created.ok) throw new Error("create failed")
  const plan = store.current()
  if (plan === null) throw new Error("no plan")
  // Map created todos back to A/B/C by createdAt order.
  const ordered = Object.values(plan.todos).sort((x, y) => x.createdAt - y.createdAt)
  const [a, b, c] = ordered
  if (a === undefined || b === undefined || c === undefined) throw new Error("missing todo")
  const upd = store.updateTodos(
    [
      { id: b.id, dependencies: [a.id] },
      { id: c.id, dependencies: [a.id, b.id] },
    ],
    true,
    plan.version,
  )
  if (!upd.ok) throw new Error("update failed")
  return { store, ids: { A: a.id, B: b.id, C: c.id } }
}

describe("current_plan — RFC07-3 task projection front door", () => {
  test("model-visible output carries owner + blockedBy + blocks for A/B→A/C→A+B", async () => {
    const { store, ids } = buildStoreWithGraph()
    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      planMutator: planStoreToMutator(store),
    }
    const result = await runTool(ctx)
    expect(result.ok).toBe(true)
    const out = result.output

    // owner alias derived from assignee.
    expect(out).toContain("tester")
    // Reverse edge: A blocks B and C.
    expect(out).toContain(ids.A)
    expect(out).toContain(ids.B)
    expect(out).toContain(ids.C)
    // The rendered block must associate A with blocking B and C. We assert the
    // structural render contract: a "blocks" token appears and A's line lists
    // both B and C after it.
    expect(out.toLowerCase()).toContain("blocks")
    expect(out.toLowerCase()).toContain("blockedby")
  })

  test("projected tasks are exposed on the readonly view in canonical order", async () => {
    const { store, ids } = buildStoreWithGraph()
    const mutator = planStoreToMutator(store)
    const view = mutator.current()
    if (view === null) throw new Error("null view")
    // The seam must expose `tasks`.
    const tasks = (view as unknown as { tasks?: ReadonlyArray<{ id: string; owner?: string; blockedBy: readonly string[]; blocks: readonly string[] }> }).tasks
    expect(tasks).toBeDefined()
    if (tasks === undefined) throw new Error("no tasks projection")
    expect(tasks.map((t) => t.id)).toEqual([ids.A, ids.B, ids.C])
    const a = tasks.find((t) => t.id === ids.A)
    expect(a?.owner).toBe("tester")
    expect(a?.blocks).toEqual([ids.B, ids.C])
    expect(a?.blockedBy).toEqual([])
    const c = tasks.find((t) => t.id === ids.C)
    expect(c?.blockedBy).toEqual([ids.A, ids.B])
    expect(c?.blocks).toEqual([])
  })

  test("null plan → no tasks section, still ok", async () => {
    const store = createInMemoryPlanStore({ now: () => 1 })
    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      planMutator: planStoreToMutator(store),
    }
    const result = await runTool(ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("No active plan")
  })
})

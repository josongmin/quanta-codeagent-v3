/**
 * RFC12-1 hellgate — `current_plan view:"graph"` emits a fenced mermaid block.
 *
 * FRONT-DOOR: a real `PlanStore` → `planStoreToMutator` → `current_plan` with
 * `view:"graph"` and the `QUANTA_PLAN_GRAPH` gate ON must emit a ```mermaid```
 * fenced block carrying the DAG (nodes + `dep --> id` edges) the existing
 * `rich-markers` renderer detects.
 *
 * GATE-OFF byte-identical: gate unset ⇒ `view:"graph"` yields the EXACT text
 * render (no fence). The default `view:"text"` output is byte-identical to a
 * no-args call whether the gate is on or off.
 *
 * RED-ON-INJECTION: covered by the projector's own gate (drop the edge walk ⇒
 * the fence loses every `-->`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { planStoreToMutator } from "../../../../src/agent/plan/mutator-adapter"
import { createInMemoryPlanStore } from "../../../../src/agent/plan/state"
import { detectRichSegments } from "../../../../src/artifact/rich-markers"
import { __resetRuntimeConfig } from "../../../../src/shared/runtime-config"
import { currentPlanTool } from "../../../../src/tool/plan/current-plan"
import type { ToolContext, ToolEvent } from "../../../../src/tool/types"

const runTool = async (
  ctx: ToolContext,
  input: { view?: "text" | "graph" },
): Promise<Extract<ToolEvent, { type: "result" }>["result"]> => {
  const events: ToolEvent[] = []
  for await (const ev of currentPlanTool().execute(input, ctx)) events.push(ev)
  const last = events[events.length - 1]
  if (last?.type !== "result") throw new Error("no result event")
  return last.result
}

const buildGraphStore = () => {
  let clock = 100
  const store = createInMemoryPlanStore({ now: () => clock++ })
  const created = store.create({
    name: "p",
    overview: "o",
    todos: [{ content: "task A" }, { content: "task B" }, { content: "task C" }],
  })
  if (!created.ok) throw new Error("create failed")
  const plan = store.current()
  if (plan === null) throw new Error("no plan")
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

const ctxFor = (store: ReturnType<typeof buildGraphStore>["store"]): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  planMutator: planStoreToMutator(store),
})

describe("current_plan view:graph (QUANTA_PLAN_GRAPH)", () => {
  beforeEach(() => __resetRuntimeConfig())
  afterEach(() => {
    delete process.env.QUANTA_PLAN_GRAPH
    __resetRuntimeConfig()
  })

  test("gate ON + view:graph ⇒ a fenced mermaid block with the DAG edges", async () => {
    process.env.QUANTA_PLAN_GRAPH = "1"
    __resetRuntimeConfig()
    const { store, ids } = buildGraphStore()
    const result = await runTool(ctxFor(store), { view: "graph" })
    expect(result.ok).toBe(true)
    const out = result.output
    // The fence exists and rich-markers detects exactly one mermaid segment.
    expect(out).toContain("```mermaid")
    const segs = detectRichSegments(out)
    const mermaid = segs.filter((s) => s.kind === "mermaid")
    expect(mermaid.length).toBe(1)
    // The DAG body carries the graph header + the right edges.
    const body = mermaid[0]?.body ?? ""
    expect(body).toContain("graph TD")
    expect(body).toContain(`${ids.A} --> ${ids.B}`)
    expect(body).toContain(`${ids.A} --> ${ids.C}`)
    expect(body).toContain(`${ids.B} --> ${ids.C}`)
  })

  test("GATE-OFF: view:graph ⇒ the text render, NO mermaid fence", async () => {
    const { store } = buildGraphStore()
    const result = await runTool(ctxFor(store), { view: "graph" })
    expect(result.ok).toBe(true)
    expect(result.output).not.toContain("```mermaid")
    expect(result.output).toContain("Current plan:")
  })

  test("GATE-OFF byte-identical: view:graph output === no-args output", async () => {
    const { store } = buildGraphStore()
    const graphOut = await runTool(ctxFor(store), { view: "graph" })
    const plainOut = await runTool(ctxFor(store), {})
    expect(graphOut.output).toBe(plainOut.output)
  })

  test("GATE-ON but view:text (default) ⇒ still the text render, no fence", async () => {
    process.env.QUANTA_PLAN_GRAPH = "1"
    __resetRuntimeConfig()
    const { store } = buildGraphStore()
    const textOut = await runTool(ctxFor(store), { view: "text" })
    const plainOut = await runTool(ctxFor(store), {})
    expect(textOut.output).not.toContain("```mermaid")
    expect(textOut.output).toBe(plainOut.output)
  })
})

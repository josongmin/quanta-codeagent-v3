/**
 * Plan-tool hellgate (ADR-0095 draft). Covers the 5 structured plan tools
 * (`current_plan` / `create_plan` / `update_todos` / `update_plan` /
 * `remove_todos`) for:
 *
 *   - current_plan happy/null/missing-port/throw paths.
 *   - happy path → ok:true output mentions new version.
 *   - ctx.planMutator absent → ok:false + failure.mode === "error".
 *   - mutator throws → caught + ok:false + failure.mode === "error".
 *   - mutator returns each of 10 PlanMutationErrorCode → failure.mode === "rejected"
 *     and failure.reason starts with the code.
 *   - tool concurrency + read-only flags pin the contract.
 */
import { describe, expect, test } from "bun:test"
import { createPlanTool } from "../../../../src/tool/plan/create-plan"
import { currentPlanTool } from "../../../../src/tool/plan/current-plan"
import { buildPlanTools } from "../../../../src/tool/plan/index"
import { removeTodosTool } from "../../../../src/tool/plan/remove-todos"
import { updatePlanTool } from "../../../../src/tool/plan/update-plan"
import { updateTodosTool } from "../../../../src/tool/plan/update-todos"
import type {
  PlanMutationErrorCode,
  PlanMutationResult,
  PlanMutator,
  ToolContext,
  ToolEvent,
} from "../../../../src/tool/types"

const ALL_CODES: readonly PlanMutationErrorCode[] = [
  "version_conflict",
  "todo_not_found",
  "phase_not_found",
  "dependency_cycle",
  "dependency_unknown",
  "self_dependency",
  "content_too_long",
  "invalid_status_transition",
  "duplicate_id",
  "empty_plan_create",
]

const makeMutator = (override: Partial<PlanMutator> = {}): PlanMutator => ({
  create: () => ({ ok: true, version: 0, deltaKind: "created", touchedIds: ["t-1"] }),
  addTodos: () => ({ ok: true, version: 1, deltaKind: "todos_added", touchedIds: ["t-2"] }),
  updateTodos: () => ({ ok: true, version: 2, deltaKind: "todos_updated", touchedIds: ["t-1"] }),
  removeTodos: () => ({ ok: true, version: 3, deltaKind: "todos_removed", touchedIds: ["t-1"] }),
  updateMeta: () => ({ ok: true, version: 4, deltaKind: "noop", touchedIds: [] }),
  current: () => null,
  ...override,
})

const makeCtx = (mutator: PlanMutator | undefined): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...(mutator !== undefined ? { planMutator: mutator } : {}),
})

const runTool = async <T>(
  tool: { execute: (input: T, ctx: ToolContext) => AsyncIterable<ToolEvent> },
  input: T,
  ctx: ToolContext,
): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of tool.execute(input, ctx)) events.push(ev)
  return events
}

// ── current_plan ─────────────────────────────────────────────────────────

describe("current_plan", () => {
  test("happy path: returns latest version + counts", async () => {
    const evs = await runTool(
      currentPlanTool(),
      {},
      makeCtx(
        makeMutator({
          current: () => ({
            version: 7,
            name: "plan-a",
            overview: "ship it",
            isProject: true,
            todoCount: 3,
            phaseCount: 2,
          }),
        }),
      ),
    )
    const last = evs[evs.length - 1]
    expect(last?.type).toBe("result")
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
    expect(last.result.output).toContain("v7")
    expect(last.result.output).toContain("todos: 3")
    expect(last.result.output).toContain("phases: 2")
  })

  test("no active plan ⇒ ok:true sentinel", async () => {
    const evs = await runTool(currentPlanTool(), {}, makeCtx(makeMutator({ current: () => null })))
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
    expect(last.result.output).toBe("No active plan.")
  })

  test("planMutator absent ⇒ ok:false + failure.mode==='error'", async () => {
    const evs = await runTool(currentPlanTool(), {}, makeCtx(undefined))
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(false)
    expect(last.result.failure?.mode).toBe("error")
    expect(last.result.output).toContain("no structured plan store is wired")
    if (last.result.failure?.mode !== "error") throw new Error("expected typed plan-store error")
    expect(last.result.failure.modelVisibleError).toBe("structured plan store is not wired")
  })

  test("mutator throws ⇒ caught", async () => {
    const evs = await runTool(
      currentPlanTool(),
      {},
      makeCtx(
        makeMutator({
          current: () => {
            throw new Error("boom")
          },
        }),
      ),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(false)
    expect(last.result.failure?.mode).toBe("error")
  })
})

// ── create_plan ─────────────────────────────────────────────────────────

describe("create_plan", () => {
  test("happy path: ok:true mentions version", async () => {
    const evs = await runTool(
      createPlanTool(),
      { name: "n", overview: "o", todos: [{ content: "A" }] },
      makeCtx(makeMutator()),
    )
    const last = evs[evs.length - 1]
    expect(last?.type).toBe("result")
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
    expect(last.result.output).toContain("v0")
  })
  test("planMutator absent ⇒ ok:false + failure.mode==='error'", async () => {
    const evs = await runTool(
      createPlanTool(),
      { name: "n", overview: "o", todos: [{ content: "A" }] },
      makeCtx(undefined),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(false)
    expect(last.result.failure?.mode).toBe("error")
    expect(last.result.output).toContain("no structured plan store is wired")
    if (last.result.failure?.mode !== "error") throw new Error("expected typed plan-store error")
    expect(last.result.failure.modelVisibleError).toBe("structured plan store is not wired")
  })
  test("mutator throws ⇒ caught", async () => {
    const evs = await runTool(
      createPlanTool(),
      { name: "n", overview: "o", todos: [{ content: "A" }] },
      makeCtx(
        makeMutator({
          create: () => {
            throw new Error("boom")
          },
        }),
      ),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(false)
    expect(last.result.failure?.mode).toBe("error")
  })
  for (const code of ALL_CODES) {
    test(`maps mutator code='${code}' → failure.mode==='rejected'`, async () => {
      const result: PlanMutationResult = { ok: false, reason: "x", code }
      const evs = await runTool(
        createPlanTool(),
        { name: "n", overview: "o", todos: [{ content: "A" }] },
        makeCtx(makeMutator({ create: () => result })),
      )
      const last = evs[evs.length - 1]
      if (last?.type !== "result") throw new Error()
      expect(last.result.ok).toBe(false)
      expect(last.result.failure?.mode).toBe("rejected")
      if (last.result.failure?.mode !== "rejected") throw new Error()
      expect(last.result.failure.reason).toContain(code)
    })
  }
})

// ── update_todos ────────────────────────────────────────────────────────

describe("update_todos", () => {
  test("happy: ok:true mentions version", async () => {
    const evs = await runTool(
      updateTodosTool(),
      { patches: [{ id: "t-1", status: "in_progress" }], merge: true, expected_version: 1 },
      makeCtx(makeMutator()),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
    expect(last.result.output).toContain("v2")
  })
  test("missing port", async () => {
    const evs = await runTool(
      updateTodosTool(),
      { patches: [{ id: "t-1" }], merge: true, expected_version: 1 },
      makeCtx(undefined),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(false)
  })
  test("version_conflict ⇒ rejected", async () => {
    const evs = await runTool(
      updateTodosTool(),
      { patches: [{ id: "t-1" }], merge: true, expected_version: 99 },
      makeCtx(
        makeMutator({
          updateTodos: () => ({ ok: false, code: "version_conflict", reason: "stale" }),
        }),
      ),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.failure?.mode).toBe("rejected")
  })
  test("merge boolean passes through to mutator", async () => {
    const captured: { merge?: boolean; ev?: number } = {}
    await runTool(
      updateTodosTool(),
      { patches: [{ id: "t-1" }], merge: false, expected_version: 5 },
      makeCtx(
        makeMutator({
          updateTodos: (_p, merge, ev) => {
            captured.merge = merge
            captured.ev = ev
            return { ok: true, version: 6, deltaKind: "noop", touchedIds: [] }
          },
        }),
      ),
    )
    expect(captured.merge).toBe(false)
    expect(captured.ev).toBe(5)
  })
})

// ── update_plan ─────────────────────────────────────────────────────────

describe("update_plan", () => {
  test("happy: ok:true", async () => {
    const evs = await runTool(
      updatePlanTool(),
      { name: "new", expected_version: 1 },
      makeCtx(makeMutator()),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
  })
  test("phase_not_found ⇒ rejected", async () => {
    const evs = await runTool(
      updatePlanTool(),
      { phase_order: ["nope"], expected_version: 1 },
      makeCtx(
        makeMutator({
          updateMeta: () => ({ ok: false, code: "phase_not_found", reason: "x" }),
        }),
      ),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.failure?.mode).toBe("rejected")
  })
  test("phase_order undefined → mutator receives no phaseOrder field", async () => {
    const captured: { hasPhaseOrder?: boolean } = {}
    await runTool(
      updatePlanTool(),
      { name: "n", expected_version: 1 },
      makeCtx(
        makeMutator({
          updateMeta: (args) => {
            captured.hasPhaseOrder = "phaseOrder" in args
            return { ok: true, version: 2, deltaKind: "noop", touchedIds: [] }
          },
        }),
      ),
    )
    expect(captured.hasPhaseOrder).toBe(false)
  })
})

// ── remove_todos ────────────────────────────────────────────────────────

describe("remove_todos", () => {
  test("happy: ok:true", async () => {
    const evs = await runTool(
      removeTodosTool(),
      { ids: ["t-1"], expected_version: 1 },
      makeCtx(makeMutator()),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.ok).toBe(true)
  })
  test("dependency_unknown ⇒ rejected (dangling guard)", async () => {
    const evs = await runTool(
      removeTodosTool(),
      { ids: ["t-1"], expected_version: 1 },
      makeCtx(
        makeMutator({
          removeTodos: () => ({ ok: false, code: "dependency_unknown", reason: "dangling" }),
        }),
      ),
    )
    const last = evs[evs.length - 1]
    if (last?.type !== "result") throw new Error()
    expect(last.result.failure?.mode).toBe("rejected")
    if (last.result.failure?.mode !== "rejected") throw new Error()
    expect(last.result.failure.reason).toContain("dependency_unknown")
  })
  test("ids order preserved to mutator", async () => {
    const captured: { ids?: readonly string[] } = {}
    await runTool(
      removeTodosTool(),
      { ids: ["a", "b", "c"], expected_version: 1 },
      makeCtx(
        makeMutator({
          removeTodos: (ids) => {
            captured.ids = ids
            return { ok: true, version: 2, deltaKind: "todos_removed", touchedIds: [...ids] }
          },
        }),
      ),
    )
    expect(captured.ids).toEqual(["a", "b", "c"])
  })
})

// ── tool contract claims (read-only / concurrency) ─────────────────────

describe("tool contract claims", () => {
  test("read-only flags pin the split: current_plan read-only, 4 mutators not", () => {
    expect(currentPlanTool().isReadOnly()).toBe(true)
    expect(createPlanTool().isReadOnly()).toBe(false)
    expect(updateTodosTool().isReadOnly()).toBe(false)
    expect(updatePlanTool().isReadOnly()).toBe(false)
    expect(removeTodosTool().isReadOnly()).toBe(false)
  })
  test("concurrency-safe:true for all 5 (sync mutator / snapshot read)", () => {
    expect(currentPlanTool().isConcurrencySafe({})).toBe(true)
    expect(createPlanTool().isConcurrencySafe({ name: "x", overview: "y", todos: [] })).toBe(true)
    expect(
      updateTodosTool().isConcurrencySafe({ patches: [], merge: true, expected_version: 0 }),
    ).toBe(true)
    expect(updatePlanTool().isConcurrencySafe({ expected_version: 0 })).toBe(true)
    expect(removeTodosTool().isConcurrencySafe({ ids: ["x"], expected_version: 0 })).toBe(true)
  })
  test("buildPlanTools registers current_plan first, then the 4 mutators", () => {
    expect(buildPlanTools().map((t) => t.name)).toEqual([
      "current_plan",
      "create_plan",
      "update_todos",
      "update_plan",
      "remove_todos",
    ])
  })
})

// ── error-code coverage drift gate ─────────────────────────────────────

describe("PlanMutationErrorCode coverage", () => {
  test("ALL_CODES has 10 entries — drift gate vs producer", () => {
    expect(ALL_CODES).toHaveLength(10)
  })
})

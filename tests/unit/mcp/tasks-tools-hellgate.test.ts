/** ADR-0196 — mcp_tasks model-tool wiring hellgate.
 *
 *  Sections (12 cases):
 *    list_mcp_tasks: empty, populated, paginated, cursor-stale → ok:false
 *    get_mcp_task: not-found, not-ready, completed, failed, cancelled
 *    cancel_mcp_task: ok, idempotent, not-cancellable, not-found
 *    tier classification: cancel is always-confirm; list/get are read-only */

import { describe, expect, test } from "bun:test"
import type { TasksHandle } from "@/tool"
import { cancelMcpTaskTool, getMcpTaskTool, listMcpTasksTool, mcpTasksTools } from "@/tool"

const fakePort = (overrides: Partial<TasksHandle> = {}): TasksHandle => ({
  list: async () => ({ ok: true, page: { tasks: [] } }),
  getInfo: async () => null,
  getResult: async () => ({ state: "not-ready" }),
  cancel: async () => ({ ok: false, reason: "not-found" }),
  ...overrides,
})

const drain = async (
  iter: AsyncIterable<{ type: string; result?: { ok: boolean; output: string } }>,
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | undefined
  for await (const e of iter) {
    if (e.type === "result" && e.result !== undefined) last = e.result
  }
  if (!last) throw new Error("no result")
  return last
}

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal })

describe("list_mcp_tasks tool", () => {
  test("empty store → ok:true with explanatory text", async () => {
    const tool = listMcpTasksTool(fakePort())
    const r = await drain(tool.execute({}, ctx()))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("no MCP tasks")
  })

  test("populated store renders id + state + optional title/progress", async () => {
    const port = fakePort({
      list: async () => ({
        ok: true,
        page: {
          tasks: [
            { taskId: "t1", state: "pending" },
            { taskId: "t2", state: "in_progress", title: "hello", progress: 0.5 },
          ],
        },
      }),
    })
    const r = await drain(listMcpTasksTool(port).execute({}, ctx()))
    expect(r.output).toContain("t1")
    expect(r.output).toContain("[pending]")
    expect(r.output).toContain("t2")
    expect(r.output).toContain("hello")
    expect(r.output).toContain("50%")
  })

  test("nextCursor is surfaced in output footer", async () => {
    const port = fakePort({
      list: async () => ({
        ok: true,
        page: { tasks: [{ taskId: "t1", state: "pending" }], nextCursor: "abc" },
      }),
    })
    const r = await drain(listMcpTasksTool(port).execute({}, ctx()))
    expect(r.output).toContain("nextCursor: abc")
  })

  test("cursor-stale failure → ok:false", async () => {
    const port = fakePort({
      list: async () => ({ ok: false, failure: { reason: "cursor-stale" } }),
    })
    const r = await drain(listMcpTasksTool(port).execute({ cursor: "999" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("cursor-stale")
  })

  test("read-only + concurrency-safe", () => {
    const tool = listMcpTasksTool(fakePort())
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe({})).toBe(true)
  })
})

describe("get_mcp_task tool", () => {
  test("not-found → ok:false", async () => {
    const r = await drain(getMcpTaskTool(fakePort()).execute({ taskId: "nope" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not-found")
  })

  test("not-ready → ok:true (model retries)", async () => {
    const port = fakePort({
      getInfo: async () => ({ taskId: "t", state: "in_progress" }),
      getResult: async () => ({ state: "not-ready" }),
    })
    const r = await drain(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("not-ready")
  })

  test("completed result carries output text", async () => {
    const port = fakePort({
      getInfo: async () => ({ taskId: "t", state: "completed" }),
      getResult: async () => ({ state: "completed", output: "the-answer" }),
    })
    const r = await drain(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.output).toContain("the-answer")
  })

  test("failed result carries error text", async () => {
    const port = fakePort({
      getInfo: async () => ({ taskId: "t", state: "failed" }),
      getResult: async () => ({ state: "failed", error: "boom" }),
    })
    const r = await drain(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.output).toContain("boom")
  })

  test("cancelled result", async () => {
    const port = fakePort({
      getInfo: async () => ({ taskId: "t", state: "cancelled" }),
      getResult: async () => ({ state: "cancelled" }),
    })
    const r = await drain(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.output).toContain("cancelled")
  })
})

describe("cancel_mcp_task tool", () => {
  test("ok cancel → ok:true", async () => {
    const port = fakePort({ cancel: async () => ({ ok: true }) })
    const r = await drain(cancelMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("cancelled")
  })

  test("not-cancellable → ok:false with rejected failure mode", async () => {
    const port = fakePort({ cancel: async () => ({ ok: false, reason: "not-cancellable" }) })
    const r = await drain(cancelMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not-cancellable")
  })

  test("not-found → ok:false with not_found failure mode", async () => {
    const r = await drain(cancelMcpTaskTool(fakePort()).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not-found")
  })

  test("hitlTier is always-confirm (destructive)", () => {
    const tool = cancelMcpTaskTool(fakePort())
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.hitlTier?.({ taskId: "t" })).toBe("always-confirm")
  })
})

describe("mcpTasksTools factory wires 3 tools in order", () => {
  test("read-only first (list, get), destructive last (cancel)", () => {
    const tools = mcpTasksTools(fakePort())
    expect(tools.map((t) => t.name)).toEqual(["list_mcp_tasks", "get_mcp_task", "cancel_mcp_task"])
  })
})

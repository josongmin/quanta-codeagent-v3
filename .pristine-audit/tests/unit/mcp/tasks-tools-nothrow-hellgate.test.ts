/** Hellgate — mcp_tasks NO-THROW boundary (Tool contract §2).
 *
 *  Round-1 audit gap: the new `if (!call.ok) yield backendErrorEvent(...)`
 *  branch in cancel_task.ts:38, get_task.ts:49/66, list_tasks.ts:47 was
 *  untested. The duck-typed `TasksHandle` is adapted from `@/mcp` at the
 *  composition root; a misbehaving / REJECTING adapter MUST NOT reject the
 *  tool's async iterator (that hangs/corrupts the dispatch loop). Every port
 *  method that throws must collapse into a single terminal `ok:false` result
 *  whose output carries the `mcp-tasks backend-error:` text, and the iterator
 *  must DRAIN cleanly (no rejection escapes).
 *
 *  Sections:
 *    list_mcp_tasks: port.list() rejects               → ok:false backend-error
 *    get_mcp_task:   port.getInfo() rejects            → ok:false backend-error
 *    get_mcp_task:   getInfo ok, port.getResult() rejects → ok:false backend-error
 *    cancel_mcp_task: port.cancel() rejects            → ok:false backend-error
 *    every case: iterator settles (never rejects); failure.mode === "error".
 */

import { describe, expect, test } from "bun:test"
import type { TasksHandle, ToolEvent } from "@/tool"
import { cancelMcpTaskTool, getMcpTaskTool, listMcpTasksTool } from "@/tool"

const fakePort = (overrides: Partial<TasksHandle> = {}): TasksHandle => ({
  list: async () => ({ ok: true, page: { tasks: [] } }),
  getInfo: async () => null,
  getResult: async () => ({ state: "not-ready" }),
  cancel: async () => ({ ok: false, reason: "not-found" }),
  ...overrides,
})

/** Drain to the LAST result event — and PROVE the iterator does not reject by
 *  letting any rejection propagate out of this helper (the awaiting test then
 *  fails loudly rather than silently). */
const drainNoReject = async (
  iter: AsyncIterable<ToolEvent>,
): Promise<{ ok: boolean; output: string; failure?: { mode: string } }> => {
  let last: { ok: boolean; output: string; failure?: { mode: string } } | undefined
  for await (const e of iter) {
    if (e.type === "result") {
      last = e.result as { ok: boolean; output: string; failure?: { mode: string } }
    }
  }
  if (!last) throw new Error("no result")
  return last
}

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal })

/** A method whose promise REJECTS (not a typed ok:false — a real throw). */
const boom = (): never => {
  throw new Error("adapter exploded")
}

describe("list_mcp_tasks — port.list() rejects", () => {
  test("yields a single ok:false backend-error, iterator does NOT reject", async () => {
    const port = fakePort({
      list: async () => boom(),
    })
    const r = await drainNoReject(listMcpTasksTool(port).execute({}, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("mcp-tasks backend-error:")
    expect(r.output).toContain("adapter exploded")
    expect(r.failure?.mode).toBe("error")
  })

  test("synchronous throw (not a rejected promise) is also collapsed", async () => {
    const port = fakePort({
      // throws synchronously before returning a promise
      list: (() => {
        throw new Error("sync explode")
      }) as TasksHandle["list"],
    })
    const r = await drainNoReject(listMcpTasksTool(port).execute({}, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("mcp-tasks backend-error:")
    expect(r.output).toContain("sync explode")
  })
})

describe("get_mcp_task — port methods reject", () => {
  test("getInfo() rejects → ok:false backend-error (getResult never reached)", async () => {
    let getResultCalled = false
    const port = fakePort({
      getInfo: async () => boom(),
      getResult: async () => {
        getResultCalled = true
        return { state: "not-ready" }
      },
    })
    const r = await drainNoReject(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("mcp-tasks backend-error:")
    expect(r.output).toContain("adapter exploded")
    expect(r.failure?.mode).toBe("error")
    expect(getResultCalled).toBe(false)
  })

  test("getInfo ok but getResult() rejects → ok:false backend-error", async () => {
    const port = fakePort({
      getInfo: async () => ({ taskId: "t", state: "in_progress" }),
      getResult: async () => boom(),
    })
    const r = await drainNoReject(getMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("mcp-tasks backend-error:")
    expect(r.output).toContain("adapter exploded")
    expect(r.failure?.mode).toBe("error")
  })
})

describe("cancel_mcp_task — port.cancel() rejects", () => {
  test("yields a single ok:false backend-error, iterator does NOT reject", async () => {
    const port = fakePort({
      cancel: async () => boom(),
    })
    const r = await drainNoReject(cancelMcpTaskTool(port).execute({ taskId: "t" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("mcp-tasks backend-error:")
    expect(r.output).toContain("adapter exploded")
    expect(r.failure?.mode).toBe("error")
  })
})

describe("no-throw contract: exactly one terminal result on a rejecting port", () => {
  test("list emits exactly one result event (no double-yield after error)", async () => {
    const port = fakePort({ list: async () => boom() })
    const events: ToolEvent[] = []
    for await (const e of listMcpTasksTool(port).execute({}, ctx())) events.push(e)
    const results = events.filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
  })
})

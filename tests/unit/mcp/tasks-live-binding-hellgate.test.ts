/** ADR-0431 — MCP tasks LIVE binding hellgate.
 *
 *  Proves the `tasks/*` JSON-RPC dispatch + composition-root wiring against a
 *  scripted in-memory JSON-RPC transport (no process spawn). Covers:
 *    - tasks/list → mcp_tasks_list tool surfaces the tasks
 *    - getInfo / getResult round-trip (completed + failed)
 *    - cancel sends tasks/cancel (verified by recorded outbound method)
 *    - server WITHOUT tasks capability ⇒ tools NOT registered (byte-identical)
 *    - server WITH tasks capability ⇒ exactly the 3 tools registered
 *    - malformed list / getInfo / getResult ⇒ typed ok:false / null / not-ready
 *    - RPC timeout ⇒ propagates as a transport error (rejects)
 *    - poller integrates with the live port */

import { describe, expect, test } from "bun:test"
import { loadMcpTools } from "@/agent"
import { clientTasksPort, McpClient } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { pollTask } from "@/mcp/tasks"
import type { McpTransport, McpTransportMessageHandler } from "@/mcp/transports/port"

/** A scripted in-memory transport. `responder(method, params)` returns the
 *  JSON-RPC `result` record, or `null` to never answer (→ request times out).
 *  Records every outbound request method for assertions. */
class ScriptedTransport implements McpTransport {
  readonly sentMethods: string[] = []
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: (() => void) | null = null

  constructor(
    private readonly responder: (method: string, params: unknown) => Record<string, unknown> | null,
  ) {}

  async start(): Promise<void> {}
  onMessage(h: McpTransportMessageHandler): () => void {
    this.msgHandler = h
    return () => {
      this.msgHandler = null
    }
  }
  onExit(h: () => void): () => void {
    this.exitHandler = h
    return () => {
      this.exitHandler = null
    }
  }
  send(payload: unknown): Error | null {
    const msg = payload as { id?: number | string; method?: string; params?: unknown }
    if (msg.method === undefined) return null // notification
    if (typeof msg.id !== "number" && typeof msg.id !== "string") return null
    this.sentMethods.push(msg.method)
    const result = this.responder(msg.method, msg.params)
    if (result === null) return null // never answer → request times out
    const reply: JsonRpcMessage = { jsonrpc: "2.0", id: msg.id, result }
    queueMicrotask(() => this.msgHandler?.(reply))
    return null
  }
  async close(): Promise<void> {
    this.exitHandler?.()
  }
}

/** Standard initialize result advertising (or not) the tasks capability. */
const initResult = (withTasks: boolean): Record<string, unknown> => ({
  protocolVersion: "2025-06-18",
  serverInfo: { name: "mock", version: "0.0.1" },
  capabilities: withTasks ? { tools: {}, tasks: { listChanged: false } } : { tools: {} },
})

const startedClient = async (
  responder: (method: string, params: unknown) => Record<string, unknown> | null,
  withTasks = true,
): Promise<{ client: McpClient; transport: ScriptedTransport }> => {
  const transport = new ScriptedTransport((method, params) => {
    if (method === "initialize") return initResult(withTasks)
    if (method === "tools/list") return { tools: [] }
    return responder(method, params)
  })
  const client = new McpClient({ name: "mock", command: ["x"] }, { transport })
  await client.start()
  return { client, transport }
}

describe("clientTasksPort — live tasks/* dispatch", () => {
  test("list surfaces tasks parsed from tasks/list", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/list"
        ? {
            tasks: [
              { taskId: "t1", state: "pending" },
              { taskId: "t2", status: "in_progress", title: "build", progress: 0.4 },
            ],
            nextCursor: "page2",
          }
        : {},
    )
    const port = clientTasksPort(client)
    const outcome = await port.list()
    expect(transport.sentMethods).toContain("tasks/list")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("expected ok")
    expect(outcome.page.tasks.map((t) => t.taskId)).toEqual(["t1", "t2"])
    expect(outcome.page.tasks[1]?.state).toBe("in_progress")
    expect(outcome.page.tasks[1]?.title).toBe("build")
    expect(outcome.page.nextCursor).toBe("page2")
    await client.stop()
  })

  test("list with cursor forwards the cursor param", async () => {
    let seen: unknown
    const { client } = await startedClient((method, params) => {
      if (method === "tasks/list") {
        seen = params
        return { tasks: [] }
      }
      return {}
    })
    await clientTasksPort(client).list("abc")
    expect(seen).toEqual({ cursor: "abc" })
    await client.stop()
  })

  test("getInfo round-trips id → status (status field accepted)", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/getInfo" ? { taskId: "t1", status: "completed" } : {},
    )
    const info = await clientTasksPort(client).getInfo("t1")
    expect(transport.sentMethods).toContain("tasks/getInfo")
    expect(info).toEqual({ taskId: "t1", state: "completed" })
    await client.stop()
  })

  test("getResult round-trips completed + failed payloads", async () => {
    const { client: c1 } = await startedClient((method) =>
      method === "tasks/getResult" ? { state: "completed", output: "answer-42" } : {},
    )
    const completed = await clientTasksPort(c1).getResult("t1")
    expect(completed).toEqual({ state: "completed", output: "answer-42" })
    await c1.stop()

    const { client: c2 } = await startedClient((method) =>
      method === "tasks/getResult" ? { status: "failed", error: "kaboom" } : {},
    )
    const failed = await clientTasksPort(c2).getResult("t1")
    expect(failed).toEqual({ state: "failed", error: "kaboom" })
    await c2.stop()
  })

  test("cancel sends tasks/cancel and maps the typed outcome", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/cancel" ? {} : {},
    )
    const ok = await clientTasksPort(client).cancel("t1")
    expect(transport.sentMethods).toContain("tasks/cancel")
    expect(ok).toEqual({ ok: true })
    await client.stop()

    const { client: c2 } = await startedClient((method) =>
      method === "tasks/cancel" ? { ok: false, reason: "not-cancellable" } : {},
    )
    expect(await clientTasksPort(c2).cancel("t1")).toEqual({
      ok: false,
      reason: "not-cancellable",
    })
    await c2.stop()
  })
})

describe("malformed / timeout responses → typed outcomes, no crash", () => {
  test("malformed list → cursor-stale ok:false", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/list" ? { garbage: true } : {},
    )
    const outcome = await clientTasksPort(client).list()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected failure")
    expect(outcome.failure.reason).toBe("cursor-stale")
    await client.stop()
  })

  test("malformed getInfo → null", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getInfo" ? { nope: 1 } : {},
    )
    expect(await clientTasksPort(client).getInfo("t1")).toBeNull()
    await client.stop()
  })

  test("malformed getResult → not-ready", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getResult" ? { weird: true } : {},
    )
    expect(await clientTasksPort(client).getResult("t1")).toEqual({ state: "not-ready" })
    await client.stop()
  })

  test("a never-answered tasks/list rejects (transport timeout propagates)", async () => {
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize") return initResult(true)
      if (method === "tools/list") return { tools: [] }
      return null // never answer
    })
    const client = new McpClient({ name: "slow", command: ["x"] }, { transport })
    // Shrink the timeout so the test is fast (private field override).
    ;(client as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 30
    await client.start()
    await expect(clientTasksPort(client).list()).rejects.toThrow(/timed out/)
    await client.stop()
  })
})

describe("composition-root wiring — default-OFF on capability", () => {
  test("server WITHOUT tasks capability ⇒ no mcp_tasks tools (byte-identical)", async () => {
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize") return initResult(false)
      if (method === "tools/list") return { tools: [] }
      return {}
    })
    const { tools, clients } = await loadMcpTools(
      [{ name: "no-tasks", command: ["x"] }],
      undefined,
      {
        transportFor: () => transport,
      },
    )
    expect(tools.some((t) => t.name === "list_mcp_tasks")).toBe(false)
    expect(tools.some((t) => t.name === "get_mcp_task")).toBe(false)
    expect(tools.some((t) => t.name === "cancel_mcp_task")).toBe(false)
    for (const c of clients) await c.stop()
  })

  test("server WITH tasks capability ⇒ exactly the 3 tools registered", async () => {
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize") return initResult(true)
      if (method === "tools/list") return { tools: [] }
      return {}
    })
    const { tools, clients } = await loadMcpTools(
      [{ name: "has-tasks", command: ["x"] }],
      undefined,
      {
        transportFor: () => transport,
      },
    )
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["cancel_mcp_task", "get_mcp_task", "list_mcp_tasks"].sort(),
    )
    for (const c of clients) await c.stop()
  })
})

describe("poller integrates with the live port", () => {
  test("pollTask resolves on terminal state via getInfo", async () => {
    let calls = 0
    const { client } = await startedClient((method) => {
      if (method === "tasks/getInfo") {
        calls += 1
        return calls < 2
          ? { taskId: "t1", state: "in_progress" }
          : { taskId: "t1", state: "completed" }
      }
      return {}
    })
    const port = clientTasksPort(client)
    const ac = new AbortController()
    const info = await pollTask(port, "t1", { signal: ac.signal, intervalMs: 1 })
    expect(info?.state).toBe("completed")
    await client.stop()
  })
})

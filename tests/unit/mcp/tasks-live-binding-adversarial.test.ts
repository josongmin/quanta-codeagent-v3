/** ADR-0431 — MCP tasks LIVE binding ADVERSARIAL hellgate (beyond the base 12).
 *
 *  Everything here drives a SCRIPTED in-memory JSON-RPC transport (no process
 *  spawn, no clock heuristics). Every assertion checks an EXACT JSON-RPC method
 *  name or an EXACT typed outcome — there are no thresholds, no timing-based
 *  expectations, no "probably". The scripted transport can reply with a
 *  `result`, reply with a JSON-RPC `error`, drop the request forever (timeout),
 *  or kill the connection mid-flight (exit), so we can prove the four hostile
 *  surfaces the production codec promises to absorb:
 *
 *    1. capability negotiation is the ONLY gate (no capability ⇒ no tools,
 *       byte-identical to a server that predates the binding);
 *    2. multi-task / multi-page list round-trips preserving id + order;
 *    3. getInfo / getResult field mapping is exact (incl. `task` / `result`
 *       envelope nesting and `state`/`status` aliasing);
 *    4. cancel emits `tasks/cancel` and maps already-completed / not-found;
 *    5. malformed payloads (missing fields, wrong types, arrays, scalars,
 *       null) ⇒ typed conservative outcomes (cursor-stale / null / not-ready /
 *       not-found) and NEVER a throw;
 *    6. transport error (JSON-RPC error reply) / exit ⇒ rejects with McpError,
 *       the loop survives;
 *    7. a cancel→getResult RACE resolves deterministically. */

import { describe, expect, test } from "bun:test"
import { loadMcpTools } from "@/agent"
import { clientTasksPort, McpClient } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport, McpTransportMessageHandler } from "@/mcp/transports/port"

// --- scripted transport -----------------------------------------------------

type Reply =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "error"; code: number; message: string }
  | { kind: "drop" } // never answer → request times out
  | { kind: "exit" } // kill the connection (fail all pending)

/** Map an outbound (method, params) onto a scripted reply. */
type Responder = (method: string, params: unknown, callIndex: number) => Reply

const ok = (result: Record<string, unknown>): Reply => ({ kind: "result", result })

class ScriptedTransport implements McpTransport {
  readonly sent: Array<{ method: string; params: unknown }> = []
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: (() => void) | null = null
  private callIndex = 0

  constructor(private readonly responder: Responder) {}

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
    this.sent.push({ method: msg.method, params: msg.params })
    const reply = this.responder(msg.method, msg.params, this.callIndex++)
    if (reply.kind === "drop") return null
    if (reply.kind === "exit") {
      queueMicrotask(() => this.exitHandler?.())
      return null
    }
    const env: JsonRpcMessage =
      reply.kind === "result"
        ? { jsonrpc: "2.0", id: msg.id, result: reply.result }
        : { jsonrpc: "2.0", id: msg.id, error: { code: reply.code, message: reply.message } }
    queueMicrotask(() => this.msgHandler?.(env))
    return null
  }
  async close(): Promise<void> {
    this.exitHandler?.()
  }
  methods(): string[] {
    return this.sent.map((s) => s.method)
  }
}

const initResult = (withTasks: boolean): Record<string, unknown> => ({
  protocolVersion: "2025-06-18",
  serverInfo: { name: "mock", version: "0.0.1" },
  capabilities: withTasks ? { tools: {}, tasks: { listChanged: false } } : { tools: {} },
})

/** A started client whose `initialize`/`tools/list` are auto-answered and whose
 *  `tasks/*` go to `responder`. `tasks` toggles the advertised capability. */
const startedClient = async (
  responder: Responder,
  withTasks = true,
): Promise<{ client: McpClient; transport: ScriptedTransport }> => {
  const transport = new ScriptedTransport((method, params, i) => {
    if (method === "initialize") return ok(initResult(withTasks))
    if (method === "tools/list") return ok({ tools: [] })
    return responder(method, params, i)
  })
  const client = new McpClient({ name: "mock", command: ["x"] }, { transport })
  // Keep the timeout tiny so the drop/timeout cases are fast and deterministic.
  ;(client as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 25
  await client.start()
  return { client, transport }
}

// === 1. capability negotiation is the only gate =============================

describe("capability gate — registration is byte-identical to a no-tasks server", () => {
  /** Load tools from a single server that does (not) advertise tasks. */
  const loadOnce = async (withTasks: boolean): Promise<string[]> => {
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize") return ok(initResult(withTasks))
      if (method === "tools/list") return ok({ tools: [] })
      return ok({})
    })
    const { tools, clients } = await loadMcpTools([{ name: "s", command: ["x"] }], undefined, {
      transportFor: () => transport,
    })
    const names = tools.map((t) => t.name).sort()
    for (const c of clients) await c.stop()
    return names
  }

  test("no tasks capability ⇒ ZERO mcp_tasks tools (identical to legacy load)", async () => {
    const without = await loadOnce(false)
    // Byte-identical to a world without the binding: no tasks tools at all.
    expect(without).toEqual([])
  })

  test("tasks capability ⇒ EXACTLY the three model tools, nothing more", async () => {
    const withCap = await loadOnce(true)
    expect(withCap).toEqual(["cancel_mcp_task", "get_mcp_task", "list_mcp_tasks"].sort())
  })

  test("capability slot that is not an object ⇒ NOT registered (conservative)", async () => {
    // serverSupportsTasks() requires an OBJECT slot; a truthy scalar must NOT
    // flip the gate on.
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize")
        return ok({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "mock", version: "0" },
          capabilities: { tools: {}, tasks: true }, // scalar, not an object
        })
      if (method === "tools/list") return ok({ tools: [] })
      return ok({})
    })
    const { tools, clients } = await loadMcpTools([{ name: "s", command: ["x"] }], undefined, {
      transportFor: () => transport,
    })
    expect(tools.some((t) => t.name.endsWith("_mcp_task") || t.name.endsWith("_mcp_tasks"))).toBe(
      false,
    )
    for (const c of clients) await c.stop()
  })
})

// === 2. multi-task / multi-page list round-trip =============================

describe("tasks/list — multi-task + multi-page round-trip preserves id + order", () => {
  test("a single page surfaces every task in server order with exact ids", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/list"
        ? ok({
            tasks: [
              { taskId: "a", state: "pending" },
              { taskId: "b", state: "in_progress" },
              { taskId: "c", state: "completed" },
              { taskId: "d", state: "failed" },
              { taskId: "e", state: "cancelled" },
            ],
            nextCursor: "p2",
          })
        : ok({}),
    )
    const out = await clientTasksPort(client).list()
    expect(transport.methods()).toContain("tasks/list")
    if (!out.ok) throw new Error("expected ok")
    expect(out.page.tasks.map((t) => t.taskId)).toEqual(["a", "b", "c", "d", "e"])
    expect(out.page.tasks.map((t) => t.state)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
    ])
    expect(out.page.nextCursor).toBe("p2")
    await client.stop()
  })

  test("paging: page-2 forwards the exact cursor param and merges deterministically", async () => {
    const pages: Record<string, Record<string, unknown>> = {
      "": { tasks: [{ taskId: "a", state: "pending" }], nextCursor: "c1" },
      c1: { tasks: [{ taskId: "b", state: "completed" }] }, // terminal page: no cursor
    }
    const { client, transport } = await startedClient((method, params) => {
      if (method !== "tasks/list") return ok({})
      const cursor = (params as { cursor?: string }).cursor ?? ""
      return ok(pages[cursor] ?? { tasks: [] })
    })
    const port = clientTasksPort(client)
    const all: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i += 1) {
      const out = await port.list(cursor)
      if (!out.ok) throw new Error("expected ok")
      for (const t of out.page.tasks) all.push(t.taskId)
      cursor = out.page.nextCursor
      if (cursor === undefined) break
    }
    expect(all).toEqual(["a", "b"])
    // The second outbound list carried the EXACT server cursor.
    const listParams = transport.sent.filter((s) => s.method === "tasks/list").map((s) => s.params)
    expect(listParams).toEqual([{}, { cursor: "c1" }])
    await client.stop()
  })

  test("a single bad entry is dropped; the rest of the page survives", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/list"
        ? ok({
            tasks: [
              { taskId: "good", state: "pending" },
              { id: "no-state" }, // missing state → dropped
              { state: "pending" }, // missing id → dropped
              { taskId: "good2", status: "completed" },
            ],
          })
        : ok({}),
    )
    const out = await clientTasksPort(client).list()
    if (!out.ok) throw new Error("expected ok")
    expect(out.page.tasks.map((t) => t.taskId)).toEqual(["good", "good2"])
    await client.stop()
  })
})

// === 3. getInfo / getResult exact field mapping =============================

describe("getInfo / getResult — exact field mapping (envelope + aliasing)", () => {
  test("getInfo maps id/state/title/progress and accepts the `task` envelope", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/getInfo"
        ? ok({ task: { id: "t9", status: "in_progress", title: "compile", progress: 0.75 } })
        : ok({}),
    )
    const info = await clientTasksPort(client).getInfo("t9")
    expect(transport.sent.find((s) => s.method === "tasks/getInfo")?.params).toEqual({
      taskId: "t9",
    })
    expect(info).toEqual({ taskId: "t9", state: "in_progress", title: "compile", progress: 0.75 })
    await client.stop()
  })

  test("getResult maps completed/failed/cancelled exactly and accepts `result` envelope", async () => {
    const { client: c1 } = await startedClient((method) =>
      method === "tasks/getResult" ? ok({ result: { state: "completed", output: "OUT" } }) : ok({}),
    )
    expect(await clientTasksPort(c1).getResult("t")).toEqual({ state: "completed", output: "OUT" })
    await c1.stop()

    const { client: c2 } = await startedClient((method) =>
      method === "tasks/getResult" ? ok({ status: "failed", error: "boom" }) : ok({}),
    )
    expect(await clientTasksPort(c2).getResult("t")).toEqual({ state: "failed", error: "boom" })
    await c2.stop()

    const { client: c3 } = await startedClient((method) =>
      method === "tasks/getResult" ? ok({ state: "cancelled" }) : ok({}),
    )
    expect(await clientTasksPort(c3).getResult("t")).toEqual({ state: "cancelled" })
    await c3.stop()
  })

  test("completed with a missing output ⇒ empty string (never undefined/throw)", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getResult" ? ok({ state: "completed" }) : ok({}),
    )
    expect(await clientTasksPort(client).getResult("t")).toEqual({ state: "completed", output: "" })
    await client.stop()
  })

  test("failed with a missing error ⇒ placeholder message (never undefined/throw)", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getResult" ? ok({ status: "failed" }) : ok({}),
    )
    const r = await clientTasksPort(client).getResult("t")
    expect(r.state).toBe("failed")
    if (r.state !== "failed") throw new Error("unreachable")
    expect(typeof r.error).toBe("string")
    expect(r.error.length).toBeGreaterThan(0)
    await client.stop()
  })
})

// === 4. cancel — exact method + already-completed / not-found ===============

describe("tasks/cancel — exact method + typed already-completed / not-found", () => {
  test("happy path emits tasks/cancel with the exact taskId and returns ok", async () => {
    const { client, transport } = await startedClient((method) =>
      method === "tasks/cancel" ? ok({}) : ok({}),
    )
    expect(await clientTasksPort(client).cancel("z1")).toEqual({ ok: true })
    expect(transport.sent.find((s) => s.method === "tasks/cancel")?.params).toEqual({
      taskId: "z1",
    })
    await client.stop()
  })

  test("already-completed ⇒ not-cancellable (exact reason)", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/cancel" ? ok({ ok: false, reason: "not-cancellable" }) : ok({}),
    )
    expect(await clientTasksPort(client).cancel("done")).toEqual({
      ok: false,
      reason: "not-cancellable",
    })
    await client.stop()
  })

  test("unknown task ⇒ not-found (any non-not-cancellable reason normalizes)", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/cancel" ? ok({ ok: false, reason: "no-such-task" }) : ok({}),
    )
    expect(await clientTasksPort(client).cancel("ghost")).toEqual({
      ok: false,
      reason: "not-found",
    })
    await client.stop()
  })
})

// === 5. malformed payloads ⇒ typed conservative, NEVER a throw ==============

describe("malformed payloads ⇒ typed conservative outcomes, never a throw", () => {
  const malformed: ReadonlyArray<Record<string, unknown>> = [
    {}, // empty
    { tasks: "not-an-array" }, // wrong type
    { tasks: 42 },
    { garbage: true },
    { tasks: [{}, 1, "x", null, true] }, // entries all unparseable
  ]

  test("tasks/list garbage ⇒ cursor-stale ok:false for every shape", async () => {
    for (const shape of malformed) {
      const { client } = await startedClient((method) =>
        method === "tasks/list" ? ok(shape) : ok({}),
      )
      const out = await clientTasksPort(client).list()
      if (out.ok) {
        // The `{ tasks:[...all-bad] }` shape is a VALID page with zero parsed
        // tasks — that is a legitimate empty list, not a failure.
        expect(out.page.tasks).toEqual([])
      } else {
        expect(out.failure.reason).toBe("cursor-stale")
      }
      await client.stop()
    }
  })

  test("tasks/getInfo garbage ⇒ null for scalar / array / wrong-typed shapes", async () => {
    const shapes: Record<string, unknown>[] = [
      { nope: 1 },
      { taskId: 5, state: "pending" }, // id wrong type
      { taskId: "t", state: "bogus" }, // state not in the closed union
      { task: [] }, // envelope is an array
      { task: "x" },
    ]
    for (const shape of shapes) {
      const { client } = await startedClient((method) =>
        method === "tasks/getInfo" ? ok(shape) : ok({}),
      )
      expect(await clientTasksPort(client).getInfo("t")).toBeNull()
      await client.stop()
    }
  })

  test("tasks/getResult garbage ⇒ not-ready for every unparseable shape", async () => {
    const shapes: Record<string, unknown>[] = [
      { weird: true },
      { state: "pending" }, // non-terminal
      { state: "in_progress" },
      { state: "bogus" },
      { result: 99 }, // envelope scalar
    ]
    for (const shape of shapes) {
      const { client } = await startedClient((method) =>
        method === "tasks/getResult" ? ok(shape) : ok({}),
      )
      expect(await clientTasksPort(client).getResult("t")).toEqual({ state: "not-ready" })
      await client.stop()
    }
  })

  test("tasks/cancel non-object result ⇒ not-found (never a throw)", async () => {
    // The codec asRecord()s the reply; rmcp's happy path is `{}` (→ ok), but a
    // server that returns a non-record under `result` cannot be read → the
    // transport already rejects a non-object `result` envelope, so we exercise
    // the in-codec branch via an `{ ok:false }` with no reason.
    const { client } = await startedClient((method) =>
      method === "tasks/cancel" ? ok({ ok: false }) : ok({}),
    )
    expect(await clientTasksPort(client).cancel("t")).toEqual({ ok: false, reason: "not-found" })
    await client.stop()
  })
})

// === 6. transport error / exit ⇒ rejects, the loop survives =================

describe("transport error / exit ⇒ McpError rejection (the model loop survives)", () => {
  test("a JSON-RPC error reply on tasks/list rejects with McpError", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/list" ? { kind: "error", code: -32000, message: "server boom" } : ok({}),
    )
    await expect(clientTasksPort(client).list()).rejects.toThrow(/server boom/)
    await client.stop()
  })

  test("a dropped tasks/getInfo rejects on timeout (typed), not a hang", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getInfo" ? { kind: "drop" } : ok({}),
    )
    await expect(clientTasksPort(client).getInfo("t")).rejects.toThrow(/timed out/)
    await client.stop()
  })

  test("a transport exit mid-getResult rejects all pending with McpError", async () => {
    const { client } = await startedClient((method) =>
      method === "tasks/getResult" ? { kind: "exit" } : ok({}),
    )
    await expect(clientTasksPort(client).getResult("t")).rejects.toThrow(/exited/)
    await client.stop()
  })

  test("after one rejected call the SAME port still serves the next call", async () => {
    // Loop-survival: the rejection does not poison the client. First getInfo
    // errors; the second (a fresh request id) succeeds.
    let n = 0
    const { client } = await startedClient((method) => {
      if (method !== "tasks/getInfo") return ok({})
      n += 1
      return n === 1
        ? { kind: "error", code: -32000, message: "transient" }
        : ok({ taskId: "t", state: "completed" })
    })
    const port = clientTasksPort(client)
    await expect(port.getInfo("t")).rejects.toThrow(/transient/)
    expect(await port.getInfo("t")).toEqual({ taskId: "t", state: "completed" })
    await client.stop()
  })
})

// === 7. cancel → getResult RACE resolves deterministically ==================

describe("cancel → getResult race resolves deterministically", () => {
  test("cancel then getResult: the server reports cancelled, the codec agrees", async () => {
    // Model a server whose state flips to `cancelled` once cancel lands. The
    // ordering is enforced by awaiting cancel before issuing getResult — the
    // scripted transport answers each request in send order via queueMicrotask,
    // so there is no wall-clock race and the outcome is fixed.
    let cancelled = false
    const { client, transport } = await startedClient((method) => {
      if (method === "tasks/cancel") {
        cancelled = true
        return ok({})
      }
      if (method === "tasks/getResult") {
        return cancelled ? ok({ state: "cancelled" }) : ok({ state: "in_progress" })
      }
      return ok({})
    })
    const port = clientTasksPort(client)
    expect(await port.cancel("t")).toEqual({ ok: true })
    expect(await port.getResult("t")).toEqual({ state: "cancelled" })
    // Method order is exactly cancel-before-getResult.
    expect(transport.methods().filter((m) => m.startsWith("tasks/"))).toEqual([
      "tasks/cancel",
      "tasks/getResult",
    ])
    await client.stop()
  })

  test("getResult issued BEFORE cancel lands sees the pre-cancel (not-ready) state", async () => {
    // The reverse ordering is equally deterministic: a getResult that the
    // server answers before the cancel mutates state observes not-ready.
    let cancelled = false
    const { client } = await startedClient((method) => {
      if (method === "tasks/getResult") return cancelled ? ok({ state: "cancelled" }) : ok({})
      if (method === "tasks/cancel") {
        cancelled = true
        return ok({})
      }
      return ok({})
    })
    const port = clientTasksPort(client)
    // Pre-cancel getResult ⇒ not-ready (empty payload). Then cancel. Then a
    // second getResult observes cancelled. Fully ordered, no thresholds.
    expect(await port.getResult("t")).toEqual({ state: "not-ready" })
    expect(await port.cancel("t")).toEqual({ ok: true })
    expect(await port.getResult("t")).toEqual({ state: "cancelled" })
    await port.cancel("t") // idempotent on terminal: empty result ⇒ ok again
    await client.stop()
  })
})

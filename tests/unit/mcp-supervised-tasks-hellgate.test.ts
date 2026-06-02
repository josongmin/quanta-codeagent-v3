/** ADR-0435 follow-up — supervised MCP `tasks/*` bridge hellgate.
 *
 *  Closes the documented limitation: the ADR-0431 tasks surface is now bridged
 *  on the SUPERVISED (auto-restart) load path via a handle that re-resolves the
 *  CURRENT live client per call (NOT captured once), so the `mcp_task_*` tools
 *  survive a restart that swaps the underlying client behind the supervisor.
 *
 *  Fully on a fake clock + fake timer queue — ZERO real timers, ZERO real
 *  RNG/Date.now. The whole point (no stale capture across restart) is proven by
 *  routing a tasks call AFTER the supervisor swaps to a NEW client and asserting
 *  the request landed on the NEW client, never the dead one. */

import { describe, expect, it } from "bun:test"
import { loadMcpTools, supervisedTasksToolsFor } from "@/agent/mcp-bridge"
import {
  DEFAULT_BACKOFF_POLICY,
  type McpCallResult,
  McpReconnectSupervisor,
  type McpServerConfig,
  type McpToolDef,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { Tool, ToolContext } from "@/tool"

// --- fake clock + timer queue (mirrors supervisor.hellgate idiom) -----------

interface FakeClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => () => void
  advance: (ms: number) => void
}

const makeClock = (): FakeClock => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms) => {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        timers.splice(timers.indexOf(next), 1)
        next.fn()
      }
    },
  }
}

// --- fake supervisable client (tasks-aware) ---------------------------------

interface RawCall {
  method: string
  params: unknown
}

interface FakeClientControl {
  id: string
  client: SupervisableMcpClient
  crash: (reason?: string) => void
  rawCalls: RawCall[]
  started: boolean
  stopped: boolean
}

interface FakeClientOpts {
  /** Whether this client's server advertises `capabilities.tasks`. When the
   *  property is `undefined` the method itself is OMITTED (mirrors a client like
   *  `IsolatedMcpClient` that has no tasks surface at all). */
  supportsTasks?: boolean
  /** The raw payload the client returns for any `tasks/*` request. */
  rawResult?: unknown
  tools?: McpToolDef[]
  callResult?: McpCallResult
}

const makeFakeClient = (id: string, opts: FakeClientOpts = {}): FakeClientControl => {
  const handlers = new Set<(reason?: string) => void>()
  const ctl: FakeClientControl = {
    id,
    rawCalls: [],
    started: false,
    stopped: false,
    crash: (reason) => {
      for (const h of handlers) h(reason)
    },
    client: {
      async start() {
        ctl.started = true
      },
      async listTools() {
        return opts.tools ?? [{ name: "echo", description: "", inputSchema: { type: "object" } }]
      },
      async callTool(_name, _args) {
        return opts.callResult ?? { ok: true, content: "ok" }
      },
      async stop() {
        ctl.stopped = true
      },
      onExit(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      // OMIT the tasks surface entirely when supportsTasks is undefined.
      ...(opts.supportsTasks === undefined
        ? {}
        : {
            serverSupportsTasks(): boolean {
              return opts.supportsTasks === true
            },
            async requestRaw(method: string, params?: unknown): Promise<unknown> {
              ctl.rawCalls.push({ method, params })
              return opts.rawResult ?? { tasks: [] }
            },
          }),
    },
  }
  return ctl
}

const CONFIG: McpServerConfig = { name: "srv", command: ["x"] }

const baseDeps = (clock: FakeClock, factory: SupervisorDeps["factory"]): SupervisorDeps => ({
  factory,
  policy: { ...DEFAULT_BACKOFF_POLICY },
  now: clock.now,
  setTimer: clock.setTimer,
  random: () => 0, // deterministic delay === base
})

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as unknown as ToolContext

/** Drive a tool's execute to its single result output string. */
const runTool = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: unknown }> => {
  for await (const ev of tool.execute(input, ctx())) {
    if (ev.type === "result") return { ok: ev.result.ok, output: ev.result.output }
  }
  throw new Error("tool produced no result")
}

const taskToolNames = (tools: Tool[]): string[] =>
  tools.map((t) => t.name).filter((n) => n.includes("mcp_task"))

// --- §1 supervised + tasks-advertising server ⇒ mcp_task_* present ----------

describe("ADR-0435 follow-up §1 supervised + tasks ⇒ task tools present", () => {
  it("loadMcpTools(supervised) bridges the three task tools when the server advertises tasks", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsTasks: true, rawResult: { tasks: [] } })
    const { tools, clients } = await loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => baseDeps(clock, () => live.client),
    })
    const names = taskToolNames(tools)
    expect(names.sort()).toEqual(["cancel_mcp_task", "get_mcp_task", "list_mcp_tasks"].sort())
    for (const c of clients) await c.stop()
  })
})

// --- §2 a tasks call routes to the CURRENT live client ----------------------

describe("ADR-0435 follow-up §2 routes to current client", () => {
  it("list_mcp_tasks dispatches tasks/list through the supervisor's live client", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsTasks: true, rawResult: { tasks: [] } })
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    const tools = supervisedTasksToolsFor(sup)
    const list = tools.find((t) => t.name === "list_mcp_tasks")
    expect(list).toBeDefined()

    const res = await runTool(list as Tool, {})
    expect(res.ok).toBe(true)
    expect(live.rawCalls).toEqual([{ method: "tasks/list", params: {} }])
    await sup.stop()
  })
})

// --- §3 NO STALE CAPTURE: after a restart, tasks hit the NEW client ---------

describe("ADR-0435 follow-up §3 survives restart — no stale handle", () => {
  it("after crash+restart the same task tool routes to the NEW client, never the dead one", async () => {
    const clock = makeClock()
    const first = makeFakeClient("first", { supportsTasks: true, rawResult: { tasks: [] } })
    const second = makeFakeClient("second", { supportsTasks: true, rawResult: { tasks: [] } })
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    expect(sup.current()).toBe(first.client)

    // Build the task tools ONCE, against the first client.
    const tools = supervisedTasksToolsFor(sup)
    const list = tools.find((t) => t.name === "list_mcp_tasks") as Tool

    // First call lands on the first client.
    await runTool(list, {})
    expect(first.rawCalls.map((c) => c.method)).toEqual(["tasks/list"])

    // Crash + restart → supervisor swaps to the second client.
    first.crash("boom")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.snapshot().state).toBe("healthy")
    expect(sup.current()).toBe(second.client)

    // The SAME (once-built) tool now routes to the NEW client. If the handle had
    // captured `first`, this call would hit the dead client instead.
    await runTool(list, {})
    expect(second.rawCalls.map((c) => c.method)).toEqual(["tasks/list"])
    // The dead client received NO additional traffic after the restart.
    expect(first.rawCalls.map((c) => c.method)).toEqual(["tasks/list"])
    await sup.stop()
  })

  it("a getResult call after restart parses against the NEW client's response", async () => {
    const clock = makeClock()
    const first = makeFakeClient("first", { supportsTasks: true, rawResult: { task: {} } })
    const second = makeFakeClient("second", {
      supportsTasks: true,
      // getInfo needs {taskId,state}; getResult reads {state,output}. The same
      // payload satisfies both parsers (state===completed).
      rawResult: { taskId: "t1", status: "completed", output: "done-by-second" },
    })
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    const get = supervisedTasksToolsFor(sup).find((t) => t.name === "get_mcp_task") as Tool

    first.crash()
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.current()).toBe(second.client)

    const res = await runTool(get, { taskId: "t1" })
    expect(res.ok).toBe(true)
    expect(String(res.output)).toContain("done-by-second")
    // getInfo + getResult both dispatched against the NEW client only.
    expect(second.rawCalls.map((c) => c.method)).toEqual(["tasks/getInfo", "tasks/getResult"])
    expect(first.rawCalls).toEqual([])
    await sup.stop()
  })
})

// --- §4 supervised WITHOUT tasks advertisement ⇒ absent (default-OFF) -------

describe("ADR-0435 follow-up §4 supervised without tasks ⇒ no task tools", () => {
  it("server advertises NO tasks capability ⇒ zero task tools (byte-identical to before)", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0", { supportsTasks: false })
    const { tools, clients } = await loadMcpTools([CONFIG], undefined, {
      supervisorDepsFor: () => baseDeps(clock, () => live.client),
    })
    expect(taskToolNames(tools)).toEqual([])
    for (const c of clients) await c.stop()
  })

  it("client lacking the tasks surface entirely (no serverSupportsTasks) ⇒ zero task tools", async () => {
    const clock = makeClock()
    const live = makeFakeClient("c0") // supportsTasks undefined → methods omitted
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => live.client),
    )
    expect(sup.serverSupportsTasks()).toBe(false)
    expect(supervisedTasksToolsFor(sup)).toEqual([])
    await sup.stop()
  })
})

// --- §5 DEFAULT (non-supervised) path unchanged — regression ----------------

describe("ADR-0435 follow-up §5 default path unchanged", () => {
  it("loadMcpTools without supervisorDepsFor never bridges supervised task tools", async () => {
    // An unspawnable server is skipped (today's behavior); the load never throws
    // and produces no supervised task tools.
    const { tools, clients } = await loadMcpTools([
      { name: "unspawnable", command: ["definitely-not-a-real-binary-xyz"] },
    ])
    expect(Array.isArray(tools)).toBe(true)
    for (const c of clients) await c.stop()
  })
})

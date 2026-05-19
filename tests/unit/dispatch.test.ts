import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Minimal tool whose behaviour is scripted by the constructor callback. */
const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    run: () => AsyncIterable<ToolEvent>
    schema?: z.ZodTypeAny
  },
): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
  isReadOnly: () => opts.readOnly ?? false,
  isConcurrencySafe: () => opts.readOnly ?? false,
  execute: () => opts.run(),
})

const okTool = makeTool("ok", {
  readOnly: true,
  schema: z.object({ value: z.string() }),
  run: async function* () {
    yield { type: "progress", message: "working" }
    yield { type: "result", result: { ok: true, output: "all good" } }
  },
})

const failTool = makeTool("fail", {
  schema: z.object({}),
  run: async function* () {
    yield { type: "result", result: { ok: false, output: "tool said no" } }
  },
})

const throwTool = makeTool("boom", {
  schema: z.object({}),
  run: async function* () {
    yield { type: "progress", message: "before throw" }
    throw new Error("kaboom")
  },
})

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([okTool, failTool, throwTool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

describe("dispatchTool happy path", () => {
  test("found read-only tool executes and returns a well-formed result block", async () => {
    const seen: string[] = []
    const res = await dispatchTool(call("ok", { value: "hi" }), config(), perm, (m) => seen.push(m))
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("all good")
    expect(res.block).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: "all good",
    })
    expect(res.block.is_error).toBeUndefined()
    expect(seen).toEqual(["working"])
  })
})

describe("dispatchTool error normalization", () => {
  test("unknown tool → deny result, not a throw", async () => {
    const res = await dispatchTool(call("ghost", {}), config(), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("unknown tool")
    expect(res.block.is_error).toBe(true)
    expect(res.block.content).toContain("Unknown tool: ghost")
  })

  test("schema-invalid input → ToolInputError normalized to an error result", async () => {
    const res = await dispatchTool(call("ok", { value: 123 }), config(), perm)
    expect(res.ok).toBe(false)
    expect(res.block.is_error).toBe(true)
    expect(res.block.content).toContain("value")
  })

  test("tool yielding ok:false → error result preserving the tool's output", async () => {
    const res = await dispatchTool(call("fail", {}), config(), perm)
    expect(res.ok).toBe(false)
    expect(res.block.is_error).toBe(true)
    expect(res.block.content).toBe("tool said no")
    expect(res.preview).toBe("tool said no")
  })

  test("tool throwing mid-execution → message captured as error result", async () => {
    const res = await dispatchTool(call("boom", {}), config(), perm)
    expect(res.ok).toBe(false)
    expect(res.block.is_error).toBe(true)
    expect(res.block.content).toBe("kaboom")
  })
})

describe("dispatchTool gates", () => {
  test("plan mode blocks a mutating tool before execute", async () => {
    let executed = false
    const guarded = makeTool("mutate", {
      readOnly: false,
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const res = await dispatchTool(
      call("mutate", {}),
      config({ registry: new ToolRegistry([guarded]), planMode: true }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("plan-blocked")
    expect(res.block.content).toContain("blocked in plan mode: mutate")
    expect(executed).toBe(false)
  })

  test("read-only tool is allowed in plan mode", async () => {
    const res = await dispatchTool(call("ok", { value: "x" }), config({ planMode: true }), perm)
    expect(res.ok).toBe(true)
  })

  test("hard-denied bash command → permission deny result", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "should not run" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      config({ registry: new ToolRegistry([bash]) }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("denied")
    expect(res.block.content).toContain("Permission denied")
  })

  test("ask decision without onConfirm → declined", async () => {
    const mutate = makeTool("mutate", {
      readOnly: false,
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const res = await dispatchTool(
      call("mutate", {}),
      config({ registry: new ToolRegistry([mutate]), permission: { mode: "default" } }),
      { mode: "default" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(res.block.content).toContain("User declined")
  })

  test("ask decision with approving onConfirm → tool runs", async () => {
    const mutate = makeTool("mutate", {
      readOnly: false,
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const res = await dispatchTool(
      call("mutate", {}),
      config({
        registry: new ToolRegistry([mutate]),
        permission: { mode: "default" },
        onConfirm: async () => true,
      }),
      { mode: "default" },
    )
    expect(res.ok).toBe(true)
    expect(res.block.content).toBe("ran")
  })

  test("pre_tool_use hook deny short-circuits before execute", async () => {
    let executed = false
    const t = makeTool("ok", {
      readOnly: true,
      schema: z.object({ value: z.string() }),
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "policy says no" }))
    const res = await dispatchTool(
      call("ok", { value: "x" }),
      config({ registry: new ToolRegistry([t]), hooks }),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("hook-denied")
    expect(res.block.content).toContain("policy says no")
    expect(executed).toBe(false)
  })

  test("post_tool_use hook receives the execution outcome", async () => {
    const events: { ok: boolean; output: string }[] = []
    const hooks = new HookBus()
    hooks.on("post_tool_use", (e) => {
      events.push({ ok: e.ok, output: e.output })
    })
    const res = await dispatchTool(call("ok", { value: "x" }), config({ hooks }), perm)
    expect(res.ok).toBe(true)
    expect(events).toEqual([{ ok: true, output: "all good" }])
  })
})

describe("dispatchTool execution context", () => {
  test("passes cwd and signal through to the tool", async () => {
    let captured: ToolContext | undefined
    const probe: Tool = {
      name: "probe",
      description: "probe ctx",
      inputSchema: z.object({}) as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: (_input, ctx) => {
        captured = ctx
        return (async function* () {
          yield { type: "result", result: { ok: true, output: "done" } }
        })()
      },
    }
    const ac = new AbortController()
    await dispatchTool(
      call("probe", {}),
      config({ registry: new ToolRegistry([probe]), cwd: "/work/here", signal: ac.signal }),
      perm,
    )
    expect(captured?.cwd).toBe("/work/here")
    expect(captured?.signal).toBe(ac.signal)
  })
})

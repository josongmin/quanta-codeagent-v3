import { describe, expect, test } from "bun:test"
import {
  createAgentTool,
  createTaskOutputTool,
  createTaskStopTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"

const ctxAt = (depth?: number): ToolContext =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
  }) as ToolContext

/** Drive a tool's execute() to completion; return the terminal result event. */
const run = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const result = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 2,
  ...r,
})

describe("createAgentTool — foreground", () => {
  test("awaits the runner and returns its summary", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result({ finalText: "fixed the bug", turns: 3 })
    }
    const tool = createAgentTool({ runner })
    const ev = await run(tool, { prompt: "fix the bug" }, ctxAt(0))

    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
    expect(ev.result.output).toContain("fixed the bug")
    expect(ev.result.output).toContain("3 turns")
    expect(seen?.depth).toBe(1)
    expect(seen?.prompt).toBe("fix the bug")
  })

  test("threads agent_type, tool allowlist, isolation and budget into the request", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })
    await run(
      tool,
      {
        prompt: "explore",
        agent_type: "Explore",
        tools: ["read", "grep"],
        isolation: "worktree",
        max_turns: 5,
        max_tokens: 1000,
      },
      ctxAt(0),
    )
    expect(seen?.agentType).toBe("Explore")
    expect(seen?.toolFilter).toEqual(["read", "grep"])
    expect(seen?.isolation).toBe("worktree")
    expect(seen?.budget).toEqual({ maxTurns: 5, maxTokens: 1000 })
  })

  test("a runner throw becomes a failed tool result, not an exception", async () => {
    const runner: SubagentRunner = async () => {
      throw new Error("loop blew up")
    }
    const tool = createAgentTool({ runner })
    const ev = await run(tool, { prompt: "x" }, ctxAt(0))
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output).toContain("loop blew up")
  })
})

describe("createAgentTool — depth limit", () => {
  test("denies when child depth would exceed maxDepth", async () => {
    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const tool = createAgentTool({ runner, maxDepth: 2 })
    // parent already at depth 2 ⇒ child would be 3 > 2 ⇒ deny
    const ev = await run(tool, { prompt: "x" }, ctxAt(2))
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output).toContain("exceeds maxDepth")
    expect(called).toBe(false)
  })

  test("allows exactly at the boundary", async () => {
    const runner: SubagentRunner = async () => result()
    const tool = createAgentTool({ runner, maxDepth: 2 })
    // parent depth 1 ⇒ child 2 == maxDepth ⇒ allowed
    const ev = await run(tool, { prompt: "x" }, ctxAt(1))
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
  })
})

describe("createAgentTool — background + Task* tools", () => {
  test("background returns a task id immediately, TaskOutput yields the result", async () => {
    let release!: (r: SubagentResult) => void
    const gate = new Promise<SubagentResult>((res) => {
      release = res
    })
    const runner: SubagentRunner = () => gate
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const out = createTaskOutputTool(reg)

    const ev = await run(agent, { prompt: "long job", background: true }, ctxAt(0))
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
    const m = ev.result.output.match(/task_id: (\S+)/)
    expect(m).not.toBeNull()
    const taskId = (m as RegExpMatchArray)[1] as string

    // Not ready yet (snapshot).
    const snap = await run(out, { task_id: taskId }, ctxAt(0))
    if (snap.type !== "result") throw new Error("expected result")
    expect(snap.result.output).toContain("status: running")

    // Settle, then a blocking poll surfaces the result.
    release(result({ finalText: "all done", turns: 4 }))
    const done = await run(out, { task_id: taskId, block: true, timeout_ms: 2000 }, ctxAt(0))
    if (done.type !== "result") throw new Error("expected result")
    expect(done.result.ok).toBe(true)
    expect(done.result.output).toContain("status: completed")
    expect(done.result.output).toContain("all done")
  })

  test("TaskStop cancels a running background task", async () => {
    const runner: SubagentRunner = () => new Promise<SubagentResult>(() => {})
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const stop = createTaskStopTool(reg)
    const out = createTaskOutputTool(reg)

    const ev = await run(agent, { prompt: "never ends", background: true }, ctxAt(0))
    if (ev.type !== "result") throw new Error("expected result")
    const taskId = (ev.result.output.match(/task_id: (\S+)/) as RegExpMatchArray)[1] as string
    const ownerToken = (
      ev.result.output.match(/owner_token: (\S+)/) as RegExpMatchArray
    )[1] as string

    const s = await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0))
    if (s.type !== "result") throw new Error("expected result")
    expect(s.result.ok).toBe(true)

    const after = await run(out, { task_id: taskId }, ctxAt(0))
    if (after.type !== "result") throw new Error("expected result")
    expect(after.result.output).toContain("status: stopped")

    // Stopping again is a no-op failure.
    const again = await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0))
    if (again.type !== "result") throw new Error("expected result")
    expect(again.result.ok).toBe(false)
  })

  test("TaskOutput on unknown id fails cleanly", async () => {
    const reg = new TaskRegistry()
    const out = createTaskOutputTool(reg)
    const ev = await run(out, { task_id: "nope" }, ctxAt(0))
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output).toContain("No task found")
  })

  test("a background runner rejection marks the task failed", async () => {
    const runner: SubagentRunner = async () => {
      throw new Error("kaboom")
    }
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const out = createTaskOutputTool(reg)
    const ev = await run(agent, { prompt: "x", background: true }, ctxAt(0))
    if (ev.type !== "result") throw new Error("expected result")
    const taskId = (ev.result.output.match(/task_id: (\S+)/) as RegExpMatchArray)[1] as string
    // No `task_stop` in this test — task settles naturally on its own — so we
    // don't need the owner_token here. Test that the launch output STILL
    // surfaces it (capability contract) but mark unused.
    expect(ev.result.output).toMatch(/owner_token: \S+/)

    const done = await run(out, { task_id: taskId, block: true, timeout_ms: 2000 }, ctxAt(0))
    if (done.type !== "result") throw new Error("expected result")
    expect(done.result.ok).toBe(false)
    expect(done.result.output).toContain("kaboom")
  })
})

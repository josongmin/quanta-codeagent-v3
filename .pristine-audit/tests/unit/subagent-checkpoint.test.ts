import { describe, expect, test } from "bun:test"
import {
  createAgentTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"

const ctxAt = (cwd: string, depth?: number): ToolContext =>
  ({
    cwd,
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
  }) as ToolContext

const run = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const result = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...r,
})

describe("createAgentTool — checkpoint", () => {
  test("checkpoint:true (no isolation) ⇒ foreground req gets <cwd>/.subagent-state/<id>.md", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })
    const ev = await run(tool, { prompt: "do it", checkpoint: true }, ctxAt("/tmp", 0))

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
    expect(seen?.checkpointPath).toBeDefined()
    // foreground synthetic id is `fg_<uuid>`; full path lives under cwd:
    expect(seen?.checkpointPath).toMatch(/^\/tmp\/\.subagent-state\/fg_[0-9a-f-]+\.md$/)
  })

  test("checkpoint:true + isolation:worktree ⇒ recoverable deny", async () => {
    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const tool = createAgentTool({ runner })
    const ev = await run(
      tool,
      { prompt: "x", checkpoint: true, isolation: "worktree" },
      ctxAt("/tmp", 0),
    )

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output.toLowerCase()).toContain("incompatible")
    expect(called).toBe(false)
  })

  test("checkpoint:false ⇒ no checkpointPath on the req", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })
    await run(tool, { prompt: "x", checkpoint: false }, ctxAt("/tmp", 0))

    expect(seen?.checkpointPath).toBeUndefined()
  })

  test("checkpoint absent ⇒ no checkpointPath (same as false)", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })
    await run(tool, { prompt: "x" }, ctxAt("/tmp", 0))

    expect(seen?.checkpointPath).toBeUndefined()
  })

  test("background + checkpoint:true ⇒ returned task_id appears in req.checkpointPath", async () => {
    let seen: SubagentRequest | undefined
    let release!: (r: SubagentResult) => void
    const gate = new Promise<SubagentResult>((res) => {
      release = res
    })
    const runner: SubagentRunner = (req) => {
      seen = req
      return gate
    }
    const reg = new TaskRegistry()
    const tool = createAgentTool({ runner, registry: reg })
    const ev = await run(
      tool,
      { prompt: "long", background: true, checkpoint: true },
      ctxAt("/tmp", 0),
    )

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
    const m = ev.result.output.match(/task_id: (\S+)/)
    expect(m).not.toBeNull()
    const taskId = (m as RegExpMatchArray)[1] as string

    expect(seen?.checkpointPath).toBe(`/tmp/.subagent-state/${taskId}.md`)
    // close out the in-flight task so test exits cleanly
    release(result())
  })

  test("cwd trailing slash is handled — only one separator between cwd and .subagent-state", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })

    // cwd without trailing slash
    await run(tool, { prompt: "a", checkpoint: true }, ctxAt("/tmp", 0))
    expect(seen?.checkpointPath?.startsWith("/tmp/.subagent-state/")).toBe(true)
    expect(seen?.checkpointPath).not.toContain("//.subagent-state")

    // cwd with trailing slash
    await run(tool, { prompt: "b", checkpoint: true }, ctxAt("/tmp/", 0))
    expect(seen?.checkpointPath?.startsWith("/tmp/.subagent-state/")).toBe(true)
    expect(seen?.checkpointPath).not.toContain("//.subagent-state")
  })
})

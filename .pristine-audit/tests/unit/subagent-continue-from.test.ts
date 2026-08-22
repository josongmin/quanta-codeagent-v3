import { describe, expect, test } from "bun:test"
import {
  createAgentTool,
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

/** Pre-populate the registry with a settled prior task that has a finalText. */
const seedSettled = (reg: TaskRegistry, finalText: string): string => {
  const id = reg.newId()
  reg.register({ id, description: "prior" })
  reg.complete(id, { ok: true, finalText, turns: 2 })
  return id
}

describe("createAgentTool — continue_from", () => {
  test("known settled task ⇒ priorAttempt threaded into req with the finalText", async () => {
    const reg = new TaskRegistry()
    const priorId = seedSettled(reg, "earlier findings: foo bar")

    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner, registry: reg })
    const ev = await run(tool, { prompt: "continue the work", continue_from: priorId }, ctxAt(0))

    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(true)
    expect(seen?.priorAttempt).toBe("earlier findings: foo bar")
    expect(seen?.prompt).toBe("continue the work")
  })

  test("unknown id ⇒ recoverable deny; runner not called", async () => {
    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const reg = new TaskRegistry()
    const tool = createAgentTool({ runner, registry: reg })
    const ev = await run(tool, { prompt: "x", continue_from: "task_does_not_exist" }, ctxAt(0))

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output.toLowerCase()).toContain("unknown")
    expect(called).toBe(false)
  })

  test("still-running task (no result yet) ⇒ deny mentions no retained finalText", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "still going" })
    // Note: never call complete/fail/stop — task remains running.

    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const tool = createAgentTool({ runner, registry: reg })
    const ev = await run(tool, { prompt: "x", continue_from: id }, ctxAt(0))

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output.toLowerCase()).toMatch(/unknown|no retained/)
    expect(called).toBe(false)
  })

  test("stopped task with empty finalText ⇒ deny", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "will stop" })
    // simulate a runner that produced no usable text before settle:
    reg.complete(id, { ok: false, finalText: "", turns: 0 })

    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const tool = createAgentTool({ runner, registry: reg })
    const ev = await run(tool, { prompt: "x", continue_from: id }, ctxAt(0))

    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.ok).toBe(false)
    expect(called).toBe(false)
  })

  test("empty-string continue_from ⇒ rejected (schema or runtime deny)", async () => {
    const reg = new TaskRegistry()
    let called = false
    const runner: SubagentRunner = async () => {
      called = true
      return result()
    }
    const tool = createAgentTool({ runner, registry: reg })

    // The current schema allows any string; an empty id will not resolve.
    // Either an InvalidInput throw OR a recoverable deny is acceptable.
    let outcome: "deny" | "throw" = "throw"
    let ev: ToolEvent | undefined
    try {
      ev = await run(tool, { prompt: "x", continue_from: "" }, ctxAt(0))
      outcome = "deny"
    } catch {
      outcome = "throw"
    }

    if (outcome === "deny") {
      if (!ev || ev.type !== "result") throw new Error("expected result")
      expect(ev.result.ok).toBe(false)
    }
    expect(called).toBe(false)
  })

  test("continue_from + prompt are BOTH passed through; slice does NOT concatenate", async () => {
    const reg = new TaskRegistry()
    const priorId = seedSettled(reg, "PRIOR SUMMARY TEXT")

    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner, registry: reg })
    await run(tool, { prompt: "next step please", continue_from: priorId }, ctxAt(0))

    expect(seen?.prompt).toBe("next step please")
    expect(seen?.priorAttempt).toBe("PRIOR SUMMARY TEXT")
    // The slice MUST NOT have merged the prior into the prompt:
    expect(seen?.prompt).not.toContain("PRIOR SUMMARY TEXT")
  })
})

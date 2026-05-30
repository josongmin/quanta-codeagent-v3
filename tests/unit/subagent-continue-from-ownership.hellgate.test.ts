/**
 * T04 hellgate — `continue_from` is gated by TASK LINEAGE/OWNERSHIP at the
 * registry/API boundary (not "any caller may read any settled task").
 *
 * Audit ref: Tier-1 "continue_from isolation" + L2 H7 / H3.
 *
 * The bug class: `resolvePriorAttempt` did `registry.get(continueFrom)` and
 * returned ANY settled task's `finalText`. A subagent that learned (or
 * guessed) a FOREIGN task id — one spawned by an unrelated agent lineage —
 * could `continue_from: <foreign-id>` and read that task's settled output as
 * its "previous attempt" seed. Cross-lineage information disclosure.
 *
 * T04 records the spawning agent's stable label (`ctx.agentLabel`) when a
 * background task is launched, and `loadContinueFromForOwner` requires the
 * REQUESTING agent's label to match the recorded owner before any data
 * access. A foreign / unknown id yields a recoverable deny — the finalText is
 * NEVER surfaced.
 */
import { describe, expect, test } from "bun:test"
import { createAgentTool, type SubagentResult, type SubagentRunner } from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"

const ctx = (agentLabel?: string): ToolContext =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(agentLabel !== undefined ? { agentLabel } : {}),
  }) as ToolContext

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, c)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const finishingRunner =
  (finalText: string): SubagentRunner =>
  async (): Promise<SubagentResult> => ({ ok: true, finalText, turns: 1 })

const launchBg = async (agent: Tool, c: ToolContext): Promise<string> => {
  const ev = await run(agent, { prompt: "job", background: true }, c)
  if (ev.type !== "result") throw new Error("expected result")
  return (ev.result.output.match(/task_id: (\S+)/) as RegExpMatchArray)[1] as string
}

/** Spin the event loop so the fire-and-forget runner settles in the registry. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 5))
}

describe("T04 — continue_from ownership gate", () => {
  test("OWNER agent CAN continue_from its own settled task (finalText seeded)", async () => {
    let observedPrior: string | undefined
    const runner: SubagentRunner = async (req) => {
      observedPrior = req.priorAttempt
      return { ok: true, finalText: "PRIOR-SECRET", turns: 1 }
    }
    const owner = ctx("agentA")
    const agent = createAgentTool({ runner })
    const taskId = await launchBg(agent, owner)
    await settle()

    // Same lineage (agentA) resumes — allowed; runner sees the prior text.
    const ev = await run(agent, { prompt: "resume", continue_from: taskId }, owner)
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(observedPrior).toBe("PRIOR-SECRET")
  })

  test("FOREIGN agent CANNOT continue_from another lineage's task (recoverable deny)", async () => {
    const agent = createAgentTool({ runner: finishingRunner("PRIOR-SECRET") })
    const taskId = await launchBg(agent, ctx("agentA"))
    await settle()

    // A different agent label tries to read agentA's settled output.
    const ev = await run(agent, { prompt: "steal", continue_from: taskId }, ctx("agentB"))
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      // The secret finalText MUST NOT leak into the deny message.
      expect(ev.result.output).not.toContain("PRIOR-SECRET")
    }
  })

  test("unknown task id ⇒ recoverable deny (no crash, no data access)", async () => {
    const agent = createAgentTool({ runner: finishingRunner("x") })
    const ev = await run(agent, { prompt: "p", continue_from: "task_nope" }, ctx("agentA"))
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
  })

  test("root-lineage isolation: a labeled child cannot read a root-owned task", async () => {
    const agent = createAgentTool({ runner: finishingRunner("ROOT-SECRET") })
    // Launched with NO agentLabel ⇒ root lineage.
    const taskId = await launchBg(agent, ctx(undefined))
    await settle()

    const ev = await run(agent, { prompt: "p", continue_from: taskId }, ctx("childX"))
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).not.toContain("ROOT-SECRET")
    }
  })

  test("root agent CAN continue_from its own root-owned task", async () => {
    let observedPrior: string | undefined
    const runner: SubagentRunner = async (req) => {
      observedPrior = req.priorAttempt
      return { ok: true, finalText: "ROOT-OK", turns: 1 }
    }
    const agent = createAgentTool({ runner })
    const taskId = await launchBg(agent, ctx(undefined))
    await settle()

    const ev = await run(agent, { prompt: "resume", continue_from: taskId }, ctx(undefined))
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(observedPrior).toBe("ROOT-OK")
  })
})

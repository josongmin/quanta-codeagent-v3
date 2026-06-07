import { describe, expect, test } from "bun:test"
import { subagentRunnerToAgentRunPort } from "@/agent/workflow-agent-adapter"
import type { SubagentRequest, SubagentResult } from "@/subagent"
import { agent, runWorkflow, sequence } from "@/workflow"

// §25.1 — Production adapter hellgate. Proves the workflow engine drives REAL
// subagent-runner semantics through the AgentRunPort bridge: finalText becomes
// the step value, ok passes through, a throw maps to agent_error (no crash),
// depth/agentType/signal are threaded, and an end-to-end 2-step workflow runs on
// a fake runner.

const okRunner =
  (byPrompt: Record<string, string>) =>
  async (req: SubagentRequest): Promise<SubagentResult> => ({
    ok: true,
    finalText: byPrompt[req.prompt] ?? "default",
    turns: 1,
  })

describe("workflow ↔ subagent-runner adapter", () => {
  test("finalText becomes the step value; ok passes through", async () => {
    const port = subagentRunnerToAgentRunPort(okRunner({ "do a thing": "RESULT" }))
    const r = await port.run({ prompt: "do a thing" })
    expect(r.ok).toBe(true)
    expect(r.text).toBe("RESULT")
  })

  test("runner ok:false → not-ok AgentRunResult (engine records agent_error)", async () => {
    const runner = async (): Promise<SubagentResult> => ({
      ok: false,
      finalText: "partial",
      turns: 2,
    })
    const wf = agent({ id: "a", prompt: "x" })
    const r = await runWorkflow(wf, { agentRun: subagentRunnerToAgentRunPort(runner) })
    const o = r.results.get("a")
    expect(o?.ok).toBe(false)
    expect(o?.ok === false && o.reason).toBe("agent_error")
  })

  test("a thrown runner error is caught → agent_error (no crash)", async () => {
    const runner = async (): Promise<SubagentResult> => {
      throw new Error("loop blew up")
    }
    const r = await runWorkflow(agent({ id: "a", prompt: "x" }), {
      agentRun: subagentRunnerToAgentRunPort(runner),
    })
    expect(r.results.get("a")?.ok).toBe(false)
  })

  test("depth + agentType + signal are threaded into each SubagentRequest", async () => {
    const seen: SubagentRequest[] = []
    const runner = async (req: SubagentRequest): Promise<SubagentResult> => {
      seen.push(req)
      return { ok: true, finalText: "ok", turns: 1 }
    }
    const ac = new AbortController()
    const port = subagentRunnerToAgentRunPort(runner, { depth: 3, agentType: "Explore" })
    await port.run({ prompt: "p", signal: ac.signal })
    expect(seen[0]?.depth).toBe(3)
    expect(seen[0]?.agentType).toBe("Explore")
    expect(seen[0]?.signal).toBe(ac.signal)
  })

  test("e2e: a 2-step workflow runs end-to-end on a fake runner", async () => {
    const port = subagentRunnerToAgentRunPort(okRunner({ "step one": "ONE", "consume ONE": "TWO" }))
    const r = await runWorkflow(
      sequence(
        agent({ id: "s1", prompt: "step one" }),
        agent({ id: "s2", prompt: (ctx) => `consume ${ctx.get<string>("s1")}` }),
      ),
      { agentRun: port },
    )
    expect(r.ok).toBe(true)
    expect(r.results.get("s2")?.ok && (r.results.get("s2") as { value: unknown }).value).toBe("TWO")
  })
})

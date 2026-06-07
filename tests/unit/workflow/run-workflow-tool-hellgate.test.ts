import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolResult } from "@/tool"
import { createRunWorkflowTool } from "@/tool/workflow/run-workflow-tool"
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "@/workflow"

// §25.1 — `run_workflow` tool hellgate. The LLM-facing surface: a JSON spec in,
// a driven-to-completion summary out. Proves the tool compiles + runs an
// LLM-authored spec end-to-end, surfaces failures honestly, rejects an invalid
// spec (clean error, no crash), and honors the concurrency cap.

const scripted = (byLabel: Record<string, string>): AgentRunPort & { calls: AgentRunRequest[] } => {
  const calls: AgentRunRequest[] = []
  return {
    calls,
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      calls.push(req)
      return { ok: true, text: (req.label !== undefined ? byLabel[req.label] : undefined) ?? "ok" }
    },
  }
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  signal: signal ?? new AbortController().signal,
})

const run = async (
  tool: ReturnType<typeof createRunWorkflowTool>,
  input: unknown,
  c?: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c ?? ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("run_workflow tool", () => {
  test("compiles + drives an LLM-authored spec to completion", async () => {
    const fake = scripted({
      "review-bugs": '{"findings":["b1","b2"]}',
      "verify-0": '{"real":true}',
      "verify-1": '{"real":false}',
    })
    const tool = createRunWorkflowTool({ agentRun: fake })
    const spec = {
      phases: [
        {
          name: "Review",
          steps: [{ id: "review-bugs", prompt: "review", outputSchema: { findings: "string[]" } }],
        },
        {
          name: "Verify",
          forEach: "review-bugs.findings",
          step: {
            id: "verify-{{index}}",
            prompt: "verify {{item}}",
            outputSchema: { real: "boolean" },
          },
        },
      ],
    }
    const r = await run(tool, spec)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("workflow complete")
    expect(r.output).toContain("✓ review-bugs")
    expect(r.output).toContain("✓ verify-0")
    expect(fake.calls.length).toBe(3) // 1 review + 2 verifies
    expect(fake.calls.map((c) => c.prompt)).toContain("verify b1")
  })

  test("a failing step is reported honestly (tool result ok:false)", async () => {
    const fake: AgentRunPort = {
      async run(): Promise<AgentRunResult> {
        return { ok: false, text: "", errorMessage: "boom" }
      },
    }
    const tool = createRunWorkflowTool({ agentRun: fake })
    const r = await run(tool, { phases: [{ steps: [{ id: "a", prompt: "x" }] }] })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("WITH FAILURES")
    expect(r.output).toContain("✗ a")
  })

  test("an invalid spec is rejected (clean error, no crash)", async () => {
    const tool = createRunWorkflowTool({ agentRun: scripted({}) })
    const r = await run(tool, { phases: [{ forEach: "x.y" }] }) // forEach w/o step
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid workflow spec")
  })

  test("concurrency cap from deps is honored (no over-subscription)", async () => {
    let inFlight = 0
    let peak = 0
    const releases: Array<() => void> = []
    const port: AgentRunPort = {
      async run(): Promise<AgentRunResult> {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise<void>((res) =>
          releases.push(() => {
            inFlight--
            res()
          }),
        )
        return { ok: true, text: "{}" }
      },
    }
    const tool = createRunWorkflowTool({ agentRun: port, concurrency: 2 })
    const spec = {
      phases: [
        {
          mode: "parallel",
          steps: Array.from({ length: 5 }, (_v, i) => ({ id: `s${i}`, prompt: `p${i}` })),
        },
      ],
    }
    let done = false
    const p = run(tool, spec).then((r) => {
      done = true
      return r
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(peak).toBe(2)
    for (let i = 0; i < 20 && !done; i++) {
      for (const rel of releases.splice(0)) rel()
      await new Promise((r) => setTimeout(r, 5))
    }
    await p
    expect(peak).toBe(2)
  })
})

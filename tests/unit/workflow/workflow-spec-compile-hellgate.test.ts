import { describe, expect, test } from "bun:test"
import {
  type AgentRunPort,
  type AgentRunRequest,
  type AgentRunResult,
  compileWorkflowSpec,
  runWorkflow,
  WorkflowSpecSchema,
} from "@/workflow"

// §25.1 — LLM-authored declarative spec → runnable workflow HELLGATE. This is
// the authoring surface: an LLM emits a JSON `WorkflowSpec` (no functions —
// fully serializable), the compiler turns it into the node tree, and the engine
// drives it to completion. Pins template resolution ({{step.field}}, {{item}},
// {{index}}), static seq/parallel phases, dynamic forEach fan-out, typed output
// threading, fail-closed on a bad id template, and spec validation.

const scripted = (
  byLabel: Record<string, string>,
  fallback = "ok",
): AgentRunPort & { calls: AgentRunRequest[] } => {
  const calls: AgentRunRequest[] = []
  return {
    calls,
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      calls.push(req)
      return {
        ok: true,
        text: (req.label !== undefined ? byLabel[req.label] : undefined) ?? fallback,
      }
    },
  }
}

const runSpec = (spec: unknown, agentRun: AgentRunPort & { calls: AgentRunRequest[] }) => {
  const parsed = WorkflowSpecSchema.parse(spec)
  return runWorkflow(compileWorkflowSpec(parsed), { agentRun })
}

describe("workflow spec — validation", () => {
  test("a phase with BOTH steps and forEach is rejected", () => {
    const bad = {
      phases: [
        { steps: [{ id: "a", prompt: "x" }], forEach: "a.items", step: { id: "b", prompt: "y" } },
      ],
    }
    expect(WorkflowSpecSchema.safeParse(bad).success).toBe(false)
  })

  test("a forEach phase missing its step template is rejected", () => {
    const bad = { phases: [{ forEach: "a.items" }] }
    expect(WorkflowSpecSchema.safeParse(bad).success).toBe(false)
  })

  test("an empty phases list is rejected", () => {
    expect(WorkflowSpecSchema.safeParse({ phases: [] }).success).toBe(false)
  })

  test("a minimal valid static spec parses", () => {
    const ok = { phases: [{ steps: [{ id: "a", prompt: "do it" }] }] }
    expect(WorkflowSpecSchema.safeParse(ok).success).toBe(true)
  })
})

describe("workflow spec — template resolution", () => {
  test("{{stepId}} interpolates a prior step's (string) value", async () => {
    const fake = scripted({ produce: "PAYLOAD", consume: "done" })
    await runSpec(
      {
        phases: [
          { steps: [{ id: "produce", prompt: "make" }] },
          { steps: [{ id: "consume", prompt: "use {{produce}}" }] },
        ],
      },
      fake,
    )
    expect(fake.calls.find((c) => c.label === "consume")?.prompt).toBe("use PAYLOAD")
  })

  test("{{stepId.field}} reaches into a typed structured output", async () => {
    const fake = scripted({ find: '{"count":42}', report: "ok" })
    await runSpec(
      {
        phases: [
          { steps: [{ id: "find", prompt: "f", outputSchema: { count: "number" } }] },
          { steps: [{ id: "report", prompt: "count is {{find.count}}" }] },
        ],
      },
      fake,
    )
    expect(fake.calls.find((c) => c.label === "report")?.prompt).toBe("count is 42")
  })

  test("a missing ref resolves to empty string (no crash)", async () => {
    const fake = scripted({ a: "go" })
    await runSpec({ phases: [{ steps: [{ id: "a", prompt: "x={{nope.field}}" }] }] }, fake)
    expect(fake.calls.find((c) => c.label === "a")?.prompt).toBe("x=")
  })

  test("an object/array ref is JSON-stringified into the template", async () => {
    const fake = scripted({ find: '{"items":["p","q"]}', use: "ok" })
    await runSpec(
      {
        phases: [
          { steps: [{ id: "find", prompt: "f", outputSchema: { items: "string[]" } }] },
          { steps: [{ id: "use", prompt: "items={{find.items}}" }] },
        ],
      },
      fake,
    )
    expect(fake.calls.find((c) => c.label === "use")?.prompt).toBe('items=["p","q"]')
  })
})

describe("workflow spec — phase modes + fan-out", () => {
  test("a parallel phase runs its steps and records all", async () => {
    const fake = scripted({ x: "X", y: "Y" })
    const r = await runSpec(
      {
        phases: [
          {
            mode: "parallel",
            steps: [
              { id: "x", prompt: "1" },
              { id: "y", prompt: "2" },
            ],
          },
        ],
      },
      fake,
    )
    expect(r.results.get("x")?.ok).toBe(true)
    expect(r.results.get("y")?.ok).toBe(true)
    expect(r.agentRuns).toBe(2)
  })

  test("forEach fans out one step per item; {{item}}/{{index}} resolve", async () => {
    const fake = scripted({ find: '{"items":["alpha","beta","gamma"]}' })
    const r = await runSpec(
      {
        phases: [
          { steps: [{ id: "find", prompt: "f", outputSchema: { items: "string[]" } }] },
          {
            forEach: "find.items",
            step: { id: "check-{{index}}", prompt: "check {{item}} at {{index}}" },
          },
        ],
      },
      fake,
    )
    expect(r.results.get("check-0")?.ok).toBe(true)
    expect(r.results.get("check-2")?.ok).toBe(true)
    expect(r.agentRuns).toBe(4) // find + 3
    const prompts = fake.calls.map((c) => c.prompt)
    expect(prompts).toContain("check alpha at 0")
    expect(prompts).toContain("check gamma at 2")
  })

  test("forEach over a non-array ref produces zero steps (no crash)", async () => {
    const fake = scripted({ find: '{"items":"notarray"}' })
    const r = await runSpec(
      {
        phases: [
          { steps: [{ id: "find", prompt: "f", outputSchema: { items: "string" } }] },
          { forEach: "find.items", step: { id: "c-{{index}}", prompt: "{{item}}" } },
        ],
      },
      fake,
    )
    expect(r.agentRuns).toBe(1) // only find
  })

  test("forEach with a NON-templated id fails CLOSED on the 2nd item (duplicate_id)", async () => {
    const fake = scripted({ find: '{"items":["a","b"]}' })
    const r = await runSpec(
      {
        phases: [
          { steps: [{ id: "find", prompt: "f", outputSchema: { items: "string[]" } }] },
          { forEach: "find.items", step: { id: "static", prompt: "{{item}}" } }, // no {{index}}
        ],
      },
      fake,
    )
    expect(r.ok).toBe(false)
    expect(
      r.events.some(
        (e) => e.type === "step_complete" && e.ok === false && e.reason === "duplicate_id",
      ),
    ).toBe(true)
  })
})

describe("workflow spec — e2e LLM-authored review", () => {
  test("a full multi-phase spec (parallel review → forEach verify) drives to completion", async () => {
    const fake = scripted({
      "review-bugs": '{"findings":["b1","b2"]}',
      "review-perf": '{"findings":["p1"]}',
      "verify-0": '{"real":true}',
      "verify-1": '{"real":false}',
      "verify-2": '{"real":true}',
    })
    const spec = {
      phases: [
        {
          name: "Review",
          mode: "parallel",
          steps: [
            { id: "review-bugs", prompt: "review bugs", outputSchema: { findings: "string[]" } },
            { id: "review-perf", prompt: "review perf", outputSchema: { findings: "string[]" } },
          ],
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
    const r = await runSpec(spec, fake)
    expect(r.ok).toBe(true)
    // 2 reviews + 2 verifies (over review-bugs' 2 findings)
    expect(r.agentRuns).toBe(4)
    expect(fake.calls.map((c) => c.prompt)).toContain("verify b1")
    const phases = r.events
      .filter((e) => e.type === "phase_enter")
      .map((e) => (e as { name: string }).name)
    expect(phases).toEqual(["Review", "Verify"])
  })
})

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  type AgentRunPort,
  type AgentRunRequest,
  type AgentRunResult,
  agent,
  fanout,
  loop,
  parallel,
  phase,
  runWorkflow,
  sequence,
  type WorkflowEvent,
} from "@/workflow"

// §25.1 — Workflow engine E2E hellgate. These exercise the FULL stack on
// realistic, composed workflows (not single operators): multi-phase
// find→verify→synthesize with structured data threaded across phases, and the
// loop-until-dry discovery pattern. The assertions pin the END-TO-END behavior
// (right confirmed set, right run counts, right phase ordering) so the engine is
// "closed" against orchestration regressions, not just unit-correct.

/** Scripted fake: maps a request (by label) to a JSON/text response. */
const scriptedAgent = (
  byLabel: Record<string, string>,
): AgentRunPort & { calls: AgentRunRequest[] } => {
  const calls: AgentRunRequest[] = []
  return {
    calls,
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      calls.push(req)
      const text = req.label !== undefined ? byLabel[req.label] : undefined
      return { ok: true, text: text ?? "{}" }
    },
  }
}

describe("workflow E2E — review → verify → synthesize", () => {
  const Findings = z.object({
    findings: z.array(z.object({ id: z.string(), title: z.string() })),
  })
  const Verdict = z.object({ real: z.boolean() })
  const Synth = z.object({ confirmed: z.array(z.string()) })

  const DIMENSIONS = ["bugs", "perf", "security"] as const
  type Finding = { id: string; title: string }
  const findingsOf = (ctx: { get<T>(id: string): T | undefined }): Finding[] =>
    DIMENSIONS.flatMap((d) => ctx.get<{ findings: Finding[] }>(`review-${d}`)?.findings ?? [])

  test("3-phase workflow threads structured findings → verdicts → synthesis", async () => {
    const events: WorkflowEvent[] = []
    const fake = scriptedAgent({
      "review-bugs": '{"findings":[{"id":"b1","title":"Bug1"},{"id":"b2","title":"Bug2"}]}',
      "review-perf": '{"findings":[{"id":"p1","title":"Perf1"}]}',
      "review-security": '{"findings":[]}', // empty dimension — zero verifies fan out
      "verify-b1": '{"real":true}',
      "verify-b2": '{"real":false}',
      "verify-p1": '{"real":true}',
      synth: '{"confirmed":["b1","p1"]}',
    })

    const wf = sequence(
      phase(
        "Review",
        parallel(
          ...DIMENSIONS.map((d) =>
            agent({ id: `review-${d}`, prompt: `review ${d}`, schema: Findings }),
          ),
        ),
      ),
      phase(
        "Verify",
        fanout({
          over: (ctx) => findingsOf(ctx),
          body: (item) => {
            const f = item as Finding
            return agent({ id: `verify-${f.id}`, prompt: `verify "${f.title}"`, schema: Verdict })
          },
        }),
      ),
      phase(
        "Synthesize",
        agent({
          id: "synth",
          schema: Synth,
          // The orchestration logic a user writes: confirmed = findings whose
          // adversarial verify returned real:true. This reads verdicts threaded
          // from the Verify phase.
          prompt: (ctx) => {
            const confirmed = findingsOf(ctx)
              .filter((f) => ctx.get<{ real: boolean }>(`verify-${f.id}`)?.real === true)
              .map((f) => f.id)
              .sort()
            return `confirmed=${confirmed.join(",")}`
          },
        }),
      ),
    )

    const r = await runWorkflow(wf, {
      agentRun: fake,
      concurrency: 4,
      sink: { emit: (e) => events.push(e) },
    })

    expect(r.ok).toBe(true)
    // 3 reviews + 3 verifies (security contributed none) + 1 synth
    expect(r.agentRuns).toBe(7)

    // Verdicts threaded correctly.
    expect(
      r.results.get("verify-b1")?.ok &&
        (r.results.get("verify-b1") as { value: { real: boolean } }).value.real,
    ).toBe(true)
    expect((r.results.get("verify-b2") as { value: { real: boolean } }).value.real).toBe(false)

    // The synth step's prompt PROVES end-to-end flow: it saw exactly the
    // verified-true findings (b1, p1) — not b2 (verified false), not anything else.
    const synthCall = fake.calls.find((c) => c.label === "synth")
    expect(synthCall?.prompt).toBe("confirmed=b1,p1")

    // Phases ran in declared order.
    const order = events
      .filter((e) => e.type === "phase_enter")
      .map((e) => (e as { name: string }).name)
    expect(order).toEqual(["Review", "Verify", "Synthesize"])

    // No verify fanned out for the empty security dimension.
    expect([...r.results.keys()].filter((k) => k.startsWith("verify-")).sort()).toEqual([
      "verify-b1",
      "verify-b2",
      "verify-p1",
    ])
  })

  test("a verify failure does not crash synthesis (failure isolation across phases)", async () => {
    const fake = scriptedAgent({
      "review-bugs": '{"findings":[{"id":"b1","title":"Bug1"},{"id":"b2","title":"Bug2"}]}',
      "review-perf": '{"findings":[]}',
      "review-security": '{"findings":[]}',
      "verify-b1": "TOTALLY NOT JSON", // schema_invalid after retries
      "verify-b2": '{"real":true}',
      synth: '{"confirmed":["b2"]}',
    })
    const wf = sequence(
      phase(
        "Review",
        parallel(
          ...DIMENSIONS.map((d) =>
            agent({ id: `review-${d}`, prompt: `review ${d}`, schema: Findings }),
          ),
        ),
      ),
      phase(
        "Verify",
        fanout({
          over: (ctx) => findingsOf(ctx),
          body: (item) => {
            const f = item as Finding
            return agent({
              id: `verify-${f.id}`,
              prompt: `v ${f.title}`,
              schema: Verdict,
              maxRetries: 1,
            })
          },
        }),
      ),
      phase(
        "Synthesize",
        agent({
          id: "synth",
          schema: Synth,
          prompt: (ctx) =>
            `confirmed=${findingsOf(ctx)
              .filter((f) => ctx.get<{ real: boolean }>(`verify-${f.id}`)?.real === true)
              .map((f) => f.id)
              .join(",")}`,
        }),
      ),
    )
    const r = await runWorkflow(wf, { agentRun: fake })
    expect(r.ok).toBe(false) // verify-b1 failed
    expect(r.results.get("verify-b1")?.ok).toBe(false)
    // But synthesis still ran and saw only the genuinely-confirmed finding.
    expect(r.results.get("synth")?.ok).toBe(true)
    expect(fake.calls.find((c) => c.label === "synth")?.prompt).toBe("confirmed=b2")
  })
})

describe("workflow E2E — loop-until-dry discovery", () => {
  const Items = z.object({ items: z.array(z.string()) })

  test("keeps finding until 2 consecutive empty rounds, then stops", async () => {
    const fake = scriptedAgent({
      "find-0": '{"items":["x1","x2"]}',
      "find-1": '{"items":["x3"]}',
      "find-2": '{"items":[]}',
      "find-3": '{"items":[]}', // 2nd dry → stop
      "find-4": '{"items":["NEVER"]}', // must not run
    })
    let iter = 0
    let dryStreak = 0
    const collected: string[] = []
    const wf = loop({
      maxIterations: 20,
      body: (i) => agent({ id: `find-${i}`, prompt: `round ${i}`, schema: Items }),
      until: (ctx) => {
        const got = ctx.get<{ items: string[] }>(`find-${iter}`)?.items ?? []
        collected.push(...got)
        dryStreak = got.length === 0 ? dryStreak + 1 : 0
        iter += 1
        return dryStreak >= 2
      },
    })
    const r = await runWorkflow(wf, { agentRun: fake })
    expect(r.agentRuns).toBe(4) // find-0..find-3
    expect(r.results.has("find-3")).toBe(true)
    expect(r.results.has("find-4")).toBe(false)
    expect(collected).toEqual(["x1", "x2", "x3"])
  })
})

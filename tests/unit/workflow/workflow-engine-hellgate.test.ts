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
  pipeline,
  runWorkflow,
  sequence,
  type WorkflowEvent,
} from "@/workflow"

// §25.1 — Workflow orchestration engine HELLGATE. Adversarial: the engine
// walks a declarative node tree spawning subagents through an injected port.
// Every load-bearing semantic is pinned here — fan-out, barrier vs no-barrier,
// failure isolation, short-circuit, structured-output retry, concurrency cap,
// runaway/budget/abort backstops, fail-closed duplicate ids — so a future
// refactor cannot silently change orchestration behavior. Determinism: a fake
// port + an explicit gate; no wall-clock decisions in the engine.

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type FakeResponse = { ok?: boolean; text?: string; tokensUsed?: number; error?: string }

/** Fake AgentRunPort. Matches a request by `label` (the engine passes
 *  `node.label ?? node.id`), falling back to a substring scan of the prompt.
 *  A value may be a single response or a QUEUE consumed per successive call to
 *  the same key (for retry scenarios). Records every call in order. */
const makeFakeAgent = (
  spec: Record<string, FakeResponse | FakeResponse[]>,
  fallback: FakeResponse = { ok: true, text: "ok" },
): AgentRunPort & { calls: AgentRunRequest[] } => {
  const calls: AgentRunRequest[] = []
  const queues = new Map<string, FakeResponse[]>()
  for (const [k, v] of Object.entries(spec)) queues.set(k, Array.isArray(v) ? [...v] : [v])
  // Consume a queue: a multi-entry queue is drained per call (retry scripts); a
  // single-entry queue is sticky. Always non-empty by construction.
  const pick = (q: FakeResponse[]): FakeResponse =>
    (q.length > 1 ? q.shift() : q[0]) as FakeResponse
  const resolve = (req: AgentRunRequest): FakeResponse => {
    const byLabel = req.label !== undefined ? queues.get(req.label) : undefined
    if (byLabel) return pick(byLabel)
    for (const [k, q] of queues) if (req.prompt.includes(k)) return pick(q)
    return fallback
  }
  return {
    calls,
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      calls.push(req)
      const r = resolve(req)
      return {
        ok: r.ok ?? true,
        text: r.text ?? "ok",
        ...(r.tokensUsed !== undefined ? { tokensUsed: r.tokensUsed } : {}),
        ...(r.error !== undefined ? { errorMessage: r.error } : {}),
      }
    },
  }
}

describe("workflow engine — atoms + composition", () => {
  test("single agent (no schema) → raw text is the value, 1 run", async () => {
    const r = await runWorkflow(agent({ id: "a", prompt: "hello" }), {
      agentRun: makeFakeAgent({ a: { text: "WORLD" } }),
    })
    expect(r.ok).toBe(true)
    expect(r.agentRuns).toBe(1)
    const o = r.results.get("a")
    expect(o?.ok).toBe(true)
    expect(o?.ok === true && o.value).toBe("WORLD")
  })

  test("sequence threads an upstream result into a downstream prompt", async () => {
    const fake = makeFakeAgent({ first: { text: "PAYLOAD" }, second: { text: "done" } })
    const r = await runWorkflow(
      sequence(
        agent({ id: "first", prompt: "produce" }),
        agent({ id: "second", prompt: (ctx) => `consume ${ctx.get<string>("first")}` }),
      ),
      { agentRun: fake },
    )
    expect(r.ok).toBe(true)
    // The second call's prompt must have seen the first's value.
    const secondCall = fake.calls.find(
      (c) => c.label === "second" || c.prompt.startsWith("consume"),
    )
    expect(secondCall?.prompt).toBe("consume PAYLOAD")
  })

  test("parallel barrier — both children run and are recorded", async () => {
    const r = await runWorkflow(
      parallel(agent({ id: "x", prompt: "p1" }), agent({ id: "y", prompt: "p2" })),
      { agentRun: makeFakeAgent({ x: { text: "X" }, y: { text: "Y" } }) },
    )
    expect(r.results.get("x")?.ok).toBe(true)
    expect(r.results.get("y")?.ok).toBe(true)
    expect(r.agentRuns).toBe(2)
  })

  test("parallel failure isolation — a failed sibling does not sink the others", async () => {
    const r = await runWorkflow(
      parallel(agent({ id: "good", prompt: "g" }), agent({ id: "bad", prompt: "b" })),
      { agentRun: makeFakeAgent({ good: { text: "G" }, bad: { ok: false, error: "boom" } }) },
    )
    expect(r.ok).toBe(false) // a step failed
    expect(r.results.get("good")?.ok).toBe(true)
    const bad = r.results.get("bad")
    expect(bad?.ok).toBe(false)
    expect(bad?.ok === false && bad.reason).toBe("agent_error")
  })

  test("downstream ctx.get of a failed step is undefined (not stale)", async () => {
    const fake = makeFakeAgent({ up: { ok: false, error: "x" }, down: { text: "d" } })
    await runWorkflow(
      sequence(
        agent({ id: "up", prompt: "u" }),
        agent({ id: "down", prompt: (ctx) => `saw=${ctx.get("up") ?? "NONE"}` }),
      ),
      { agentRun: fake },
    )
    const downCall = fake.calls.find((c) => c.prompt.startsWith("saw="))
    expect(downCall?.prompt).toBe("saw=NONE")
  })
})

describe("workflow engine — structured output", () => {
  const Schema = z.object({ n: z.number(), tag: z.string() })

  test("valid JSON → parsed + validated value", async () => {
    const r = await runWorkflow(agent({ id: "s", prompt: "p", schema: Schema }), {
      agentRun: makeFakeAgent({ s: { text: '{"n":7,"tag":"hi"}' } }),
    })
    const o = r.results.get("s")
    expect(o?.ok === true && o.value).toEqual({ n: 7, tag: "hi" })
  })

  test("JSON inside a ```json fence is extracted", async () => {
    const r = await runWorkflow(agent({ id: "s", prompt: "p", schema: Schema }), {
      agentRun: makeFakeAgent({ s: { text: 'here:\n```json\n{"n":1,"tag":"x"}\n```\nthanks' } }),
    })
    expect(r.results.get("s")?.ok).toBe(true)
  })

  test("invalid-then-valid → succeeds on retry, counts 2 runs", async () => {
    const fake = makeFakeAgent({
      s: [{ text: "not json" }, { text: '{"n":2,"tag":"ok"}' }],
    })
    const r = await runWorkflow(agent({ id: "s", prompt: "p", schema: Schema, maxRetries: 2 }), {
      agentRun: fake,
    })
    expect(r.results.get("s")?.ok).toBe(true)
    expect(r.agentRuns).toBe(2)
  })

  test("always-invalid → schema_invalid after maxRetries+1 runs", async () => {
    const fake = makeFakeAgent({ s: { text: "garbage" } })
    const r = await runWorkflow(agent({ id: "s", prompt: "p", schema: Schema, maxRetries: 2 }), {
      agentRun: fake,
    })
    const o = r.results.get("s")
    expect(o?.ok).toBe(false)
    expect(o?.ok === false && o.reason).toBe("schema_invalid")
    expect(r.agentRuns).toBe(3) // 1 + 2 retries
  })

  test("schema present but value violates constraints → invalid", async () => {
    const r = await runWorkflow(agent({ id: "s", prompt: "p", schema: Schema, maxRetries: 0 }), {
      agentRun: makeFakeAgent({ s: { text: '{"n":"NOTNUM","tag":"x"}' } }),
    })
    expect(r.results.get("s")?.ok).toBe(false)
    expect(r.agentRuns).toBe(1)
  })
})

describe("workflow engine — dynamic fan-out", () => {
  test("fanout instantiates one step per runtime item", async () => {
    const Bugs = z.object({ items: z.array(z.string()) })
    const r = await runWorkflow(
      sequence(
        agent({ id: "find", prompt: "find", schema: Bugs }),
        fanout({
          over: (ctx) => ctx.get<{ items: string[] }>("find")?.items ?? [],
          body: (item, i) => agent({ id: `fix-${i}`, prompt: `fix ${item}` }),
        }),
      ),
      { agentRun: makeFakeAgent({ find: { text: '{"items":["a","b","c"]}' } }) },
    )
    expect(r.results.get("fix-0")?.ok).toBe(true)
    expect(r.results.get("fix-1")?.ok).toBe(true)
    expect(r.results.get("fix-2")?.ok).toBe(true)
    expect(r.agentRuns).toBe(4) // find + 3
  })

  test("fanout colliding ids fail CLOSED (duplicate_id), no silent overwrite", async () => {
    const r = await runWorkflow(
      fanout({
        over: () => [1, 2, 3],
        body: () => agent({ id: "DUP", prompt: "x" }), // same id every item
      }),
      { agentRun: makeFakeAgent({ DUP: { text: "v" } }) },
    )
    // First wins; the colliding repeats are recorded as duplicate_id failures.
    expect(r.results.get("DUP")?.ok).toBe(true)
    expect(r.ok).toBe(false)
    const dupFailures = [...r.results.values()].length
    expect(dupFailures).toBeGreaterThanOrEqual(1)
    // At least one duplicate_id event must have fired.
    expect(
      r.events.some(
        (e) => e.type === "step_complete" && e.ok === false && e.reason === "duplicate_id",
      ),
    ).toBe(true)
  })

  test("fanout sequential mode preserves order", async () => {
    const fake = makeFakeAgent({}, { ok: true, text: "ok" })
    await runWorkflow(
      fanout({
        over: () => ["a", "b", "c"],
        body: (item, i) => agent({ id: `s-${i}`, prompt: `step ${item}` }),
        mode: "sequential",
      }),
      { agentRun: fake },
    )
    expect(fake.calls.map((c) => c.prompt)).toEqual(["step a", "step b", "step c"])
  })
})

describe("workflow engine — pipeline (no barrier, per-item)", () => {
  test("stages thread prev value; both stages run per item", async () => {
    const fake = makeFakeAgent({
      "review-0": { text: "R0" },
      "verify-0": { text: "V0" },
      "review-1": { text: "R1" },
      "verify-1": { text: "V1" },
    })
    const r = await runWorkflow(
      pipeline({
        over: () => ["d0", "d1"],
        stages: [
          (_prev, item, i) => agent({ id: `review-${i}`, prompt: `review ${item}` }),
          (prev, _item, i) => agent({ id: `verify-${i}`, prompt: `verify ${prev}` }),
        ],
      }),
      { agentRun: fake },
    )
    expect(r.ok).toBe(true)
    // stage 2 of item 0 saw stage 1's value
    const v0 = fake.calls.find((c) => c.label === "verify-0")
    expect(v0?.prompt).toBe("verify R0")
    expect(r.agentRuns).toBe(4)
  })

  test("a failed stage SHORT-CIRCUITS that item's remaining stages (item-isolated)", async () => {
    const fake = makeFakeAgent({
      "review-0": { ok: false, error: "bad" }, // item 0 stage1 fails
      "verify-0": { text: "SHOULD-NOT-RUN" },
      "review-1": { text: "R1" },
      "verify-1": { text: "V1" },
    })
    const r = await runWorkflow(
      pipeline({
        over: () => ["d0", "d1"],
        stages: [
          (_p, item, i) => agent({ id: `review-${i}`, prompt: `review ${item}` }),
          (prev, _item, i) => agent({ id: `verify-${i}`, prompt: `verify ${prev}` }),
        ],
      }),
      { agentRun: fake },
    )
    // item 0: stage2 never ran
    expect(fake.calls.some((c) => c.label === "verify-0")).toBe(false)
    expect(
      r.events.some(
        (e) =>
          e.type === "step_skipped" && e.id === "verify-0" && e.reason === "pipeline_short_circuit",
      ),
    ).toBe(true)
    // item 1: fully ran (isolation)
    expect(r.results.get("verify-1")?.ok).toBe(true)
  })
})

describe("workflow engine — bounded loop", () => {
  test("loop stops early when `until` is satisfied", async () => {
    let rounds = 0
    const r = await runWorkflow(
      loop({
        maxIterations: 10,
        body: (i) => agent({ id: `round-${i}`, prompt: `r${i}` }),
        until: () => {
          rounds++
          return rounds >= 3 // stop after 3 checks
        },
      }),
      { agentRun: makeFakeAgent({}) },
    )
    expect(r.results.has("round-2")).toBe(true)
    expect(r.results.has("round-3")).toBe(false)
    expect(r.agentRuns).toBe(3)
  })

  test("loop respects maxIterations backstop when `until` never fires", async () => {
    const r = await runWorkflow(
      loop({
        maxIterations: 4,
        body: (i) => agent({ id: `r-${i}`, prompt: `x${i}` }),
        until: () => false,
      }),
      { agentRun: makeFakeAgent({}) },
    )
    expect(r.agentRuns).toBe(4)
    expect(r.results.has("r-3")).toBe(true)
    expect(r.results.has("r-4")).toBe(false)
  })

  test("loop-until-count accumulates across iterations via ctx", async () => {
    // Each round finds 2 items; stop once >= 5 total seen.
    const found: string[] = []
    const r = await runWorkflow(
      loop({
        maxIterations: 10,
        body: (i) =>
          agent({
            id: `find-${i}`,
            prompt: (_ctx) => {
              found.push(`a${i}`, `b${i}`)
              return `round ${i}`
            },
          }),
        until: () => found.length >= 5,
      }),
      { agentRun: makeFakeAgent({}) },
    )
    expect(found.length).toBeGreaterThanOrEqual(5)
    expect(r.agentRuns).toBe(3) // 2 per round, stop after 3rd round (6 >= 5)
  })
})

describe("workflow engine — backstops + safety", () => {
  test("concurrency cap is never exceeded", async () => {
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
        return { ok: true, text: "ok" }
      },
    }
    const wf = parallel(
      ...Array.from({ length: 6 }, (_v, i) => agent({ id: `c${i}`, prompt: `p${i}` })),
    )
    let done = false
    const p = runWorkflow(wf, { agentRun: port, concurrency: 2 }).then((r) => {
      done = true
      return r
    })
    await delay(20)
    expect(peak).toBe(2) // saturated at exactly the cap
    // drain in waves
    for (let i = 0; i < 20 && !done; i++) {
      for (const r of releases.splice(0)) r()
      await delay(5)
    }
    const result = await p
    expect(peak).toBe(2)
    expect(result.agentRuns).toBe(6)
  })

  test("maxAgents runaway backstop stops dispatch + records max_agents skips", async () => {
    const r = await runWorkflow(
      parallel(...Array.from({ length: 10 }, (_v, i) => agent({ id: `m${i}`, prompt: `p${i}` }))),
      { agentRun: makeFakeAgent({}), maxAgents: 4 },
    )
    expect(r.agentRuns).toBe(4)
    const skipped = r.events.filter((e) => e.type === "step_skipped" && e.reason === "max_agents")
    expect(skipped.length).toBe(6)
  })

  test("pre-aborted signal → no agent runs, every step skipped aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const fake = makeFakeAgent({})
    const r = await runWorkflow(
      sequence(agent({ id: "a", prompt: "x" }), agent({ id: "b", prompt: "y" })),
      { agentRun: fake, signal: ac.signal },
    )
    expect(fake.calls.length).toBe(0)
    expect(r.agentRuns).toBe(0)
    expect(r.events.filter((e) => e.type === "step_skipped" && e.reason === "aborted").length).toBe(
      2,
    )
  })

  test("mid-run abort stops subsequent steps", async () => {
    const ac = new AbortController()
    const fake: AgentRunPort = {
      async run(req): Promise<AgentRunResult> {
        if (req.label === "a") ac.abort()
        return { ok: true, text: "ok" }
      },
    }
    const r = await runWorkflow(
      sequence(
        agent({ id: "a", prompt: "1" }),
        agent({ id: "b", prompt: "2" }),
        agent({ id: "c", prompt: "3" }),
      ),
      { agentRun: fake, signal: ac.signal },
    )
    expect(r.results.get("a")?.ok).toBe(true)
    expect(
      r.events.some((e) => e.type === "step_skipped" && e.id === "b" && e.reason === "aborted"),
    ).toBe(true)
    expect(
      r.events.some((e) => e.type === "step_skipped" && e.id === "c" && e.reason === "aborted"),
    ).toBe(true)
  })

  test("a throwing prompt builder fails only THAT step (builder_threw)", async () => {
    const r = await runWorkflow(
      sequence(
        agent({
          id: "boom",
          prompt: () => {
            throw new Error("builder kaboom")
          },
        }),
        agent({ id: "after", prompt: "still runs" }),
      ),
      { agentRun: makeFakeAgent({ after: { text: "A" } }) },
    )
    const boom = r.results.get("boom")
    expect(boom?.ok).toBe(false)
    expect(boom?.ok === false && boom.reason).toBe("builder_threw")
    expect(r.results.get("after")?.ok).toBe(true) // run continued
  })

  test("a thrown adapter error is caught → agent_error (engine never crashes)", async () => {
    const port: AgentRunPort = {
      async run(): Promise<AgentRunResult> {
        throw new Error("network down")
      },
    }
    const r = await runWorkflow(agent({ id: "a", prompt: "x" }), { agentRun: port })
    const o = r.results.get("a")
    expect(o?.ok).toBe(false)
    expect(o?.ok === false && o.reason).toBe("agent_error")
  })

  test("budget exhausted → remaining agent steps skipped budget_exhausted", async () => {
    let n = 2
    const r = await runWorkflow(
      sequence(
        agent({ id: "a", prompt: "1" }),
        agent({ id: "b", prompt: "2" }),
        agent({ id: "c", prompt: "3" }),
      ),
      {
        agentRun: makeFakeAgent({}),
        budget: {
          remaining: () => {
            // allow first two, then exhaust
            const v = n
            n -= 1
            return v
          },
        },
      },
    )
    // first two run, third is gated
    expect(r.agentRuns).toBe(2)
    expect(
      r.events.some(
        (e) => e.type === "step_skipped" && e.id === "c" && e.reason === "budget_exhausted",
      ),
    ).toBe(true)
  })
})

describe("workflow engine — progress events", () => {
  test("phase emits phase_enter before its steps; sink mirrors the log", async () => {
    const events: WorkflowEvent[] = []
    const r = await runWorkflow(phase("review", sequence(agent({ id: "a", prompt: "x" }))), {
      agentRun: makeFakeAgent({}),
      sink: { emit: (e) => events.push(e) },
    })
    expect(events).toEqual([...r.events]) // sink === result log
    const phaseIdx = events.findIndex((e) => e.type === "phase_enter" && e.name === "review")
    const startIdx = events.findIndex((e) => e.type === "step_start" && e.id === "a")
    expect(phaseIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(phaseIdx)
  })

  test("step_start carries effective label (label ?? id)", async () => {
    const events: WorkflowEvent[] = []
    await runWorkflow(agent({ id: "theId", prompt: "x", label: "Nice Label" }), {
      agentRun: makeFakeAgent({ "Nice Label": { text: "ok" } }),
      sink: { emit: (e) => events.push(e) },
    })
    expect(events.some((e) => e.type === "step_start" && e.label === "Nice Label")).toBe(true)
  })
})

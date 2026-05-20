import { describe, expect, test } from "bun:test"
import { createWorkingStateSession } from "@/agent"
import { createUpdateWorkingStateTool, type ToolContext, type WorkingStateHandle } from "@/tool"

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...over,
})

const drain = async <I>(
  tool: ReturnType<typeof createUpdateWorkingStateTool>,
  input: I,
  c: ToolContext = ctx(),
): Promise<{ ok: boolean; output: string }> => {
  let result = { ok: false, output: "" }
  for await (const ev of tool.execute(input as unknown as Parameters<typeof tool.execute>[0], c)) {
    if (ev.type === "result") result = ev.result
  }
  return result
}

describe("update_working_state tool", () => {
  test("empty input → no change, output mentions (no changes)", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    const out = await drain(tool, {})
    expect(out.ok).toBe(true)
    expect(out.output).toContain("(no changes)")
    expect(session.snapshot().ownerShortlist).toEqual([])
    expect(session.snapshot().hypothesis).toBeUndefined()
  })

  test("setting ownerShortlist replaces (not appends)", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    await drain(tool, { ownerShortlist: [{ file: "a.ts", reason: "first" }] })
    await drain(tool, { ownerShortlist: [{ file: "b.ts", reason: "second" }] })
    expect(session.snapshot().ownerShortlist).toEqual([{ file: "b.ts", reason: "second" }])
  })

  test("hypothesis: null clears the hypothesis field", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    await drain(tool, { hypothesis: "the dispatcher is suspect" })
    expect(session.snapshot().hypothesis).toBe("the dispatcher is suspect")
    await drain(tool, { hypothesis: null })
    expect(session.snapshot().hypothesis).toBeUndefined()
  })

  test("sequential calls build up state across all fields", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    await drain(tool, {
      ownerShortlist: [{ file: "a.ts", reason: "primary" }],
    })
    await drain(tool, { hypothesis: "race in stream consumer" })
    await drain(tool, {
      blockers: [{ what: "missing type guard", surface: "type" }],
    })
    await drain(tool, {
      nextStepQueue: [
        { what: "add guard", deferred: false },
        { what: "test", deferred: true },
      ],
    })
    await drain(tool, {
      deferredValidation: [{ rail: "bun test", reason: "needs fixture refactor" }],
    })

    const snap = session.snapshot()
    expect(snap.ownerShortlist).toHaveLength(1)
    expect(snap.hypothesis).toBe("race in stream consumer")
    expect(snap.blockers).toHaveLength(1)
    expect(snap.nextStepQueue).toHaveLength(2)
    expect(snap.deferredValidation).toHaveLength(1)
  })

  test("output text names every changed field", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    const out = await drain(tool, {
      ownerShortlist: [{ file: "a.ts", reason: "primary" }],
      hypothesis: "h",
      blockers: [{ what: "b", surface: "wire" }],
    })
    expect(out.output).toContain("ownerShortlist")
    expect(out.output).toContain("hypothesis")
    expect(out.output).toContain("blockers")
    // Counts in the trailing summary.
    expect(out.output).toContain("owners=1")
    expect(out.output).toContain("blockers=1")
    expect(out.output).toContain("hypothesis=set")
  })

  test("isReadOnly is false, isConcurrencySafe is false (mutates session state)", () => {
    const tool = createUpdateWorkingStateTool(createWorkingStateSession())
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({} as Parameters<typeof tool.isConcurrencySafe>[0])).toBe(false)
  })

  // Phase 6 (ADR-0021) seam: when the factory was constructed WITHOUT a
  // closure-captured handle (`undefined`), the tool falls back to the
  // ctx.workingState handle the agent loop's dispatch seam now populates.
  test("factory undefined + ctx.workingState present ⇒ ctx fallback mutates state", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(undefined)
    // Pass the session as ctx.workingState — this is the path dispatch.ts now
    // wires when `AgentConfig.workingState?.enabled === true`.
    const out = await drain(
      tool,
      { hypothesis: "via ctx" },
      ctx({ workingState: session as unknown as WorkingStateHandle }),
    )
    expect(out.ok).toBe(true)
    expect(session.snapshot().hypothesis).toBe("via ctx")
    expect(out.output).toContain("hypothesis")
  })

  // Phase 6 (ADR-0021) seam: with NEITHER closure-captured handle NOR a
  // ctx.workingState the tool reports the clear misconfig error message
  // instead of crashing on a null deref.
  test("factory undefined + ctx without workingState ⇒ clear misconfig error", async () => {
    const tool = createUpdateWorkingStateTool(undefined)
    const out = await drain(tool, { hypothesis: "x" }, ctx())
    expect(out.ok).toBe(false)
    expect(out.output).toContain("no session WorkingState is attached")
    expect(out.output).toContain("AgentConfig.workingState")
  })

  // Closure-captured handle wins over an (unexpected) ctx.workingState — the
  // closure pattern is the canonical wiring; ctx is only the fallback path.
  test("closure handle wins over ctx.workingState", async () => {
    const closureSession = createWorkingStateSession()
    const ctxSession = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(closureSession)
    await drain(
      tool,
      { hypothesis: "closure wins" },
      ctx({ workingState: ctxSession as unknown as WorkingStateHandle }),
    )
    expect(closureSession.snapshot().hypothesis).toBe("closure wins")
    expect(ctxSession.snapshot().hypothesis).toBeUndefined()
  })

  // summarize() after clearing hypothesis with `null` reports `hypothesis=none`
  // (the empty / unset rendering — distinct from `hypothesis=set`).
  test("summarize() after hypothesis:null reports hypothesis=none", async () => {
    const session = createWorkingStateSession()
    const tool = createUpdateWorkingStateTool(session)
    await drain(tool, { hypothesis: "first guess" })
    expect(session.snapshot().hypothesis).toBe("first guess")
    const out = await drain(tool, { hypothesis: null })
    expect(out.ok).toBe(true)
    expect(out.output).toContain("hypothesis=none")
    expect(out.output).not.toContain("hypothesis=set")
  })

  // SECURITY: each list array is capped at 50 entries so a single
  // update_working_state call cannot balloon the per-turn reminder block
  // indefinitely (DOS via prompt-budget exhaustion). The cap is enforced by
  // the zod schema BEFORE the tool runs, surfaced as a validation error with
  // the field name.
  describe("array length caps (.max(50))", () => {
    const tool = createUpdateWorkingStateTool(createWorkingStateSession())
    const schema = tool.inputSchema

    test("ownerShortlist with 51 entries fails validation", () => {
      const arr = Array.from({ length: 51 }, (_, i) => ({
        file: `f${i}.ts`,
        reason: `r${i}`,
      }))
      const r = schema.safeParse({ ownerShortlist: arr })
      expect(r.success).toBe(false)
      if (!r.success) {
        // The validation error must clearly name the offending field and the
        // cap (50) — so the LLM / caller can correct the input.
        const msg = JSON.stringify(r.error.issues)
        expect(msg).toMatch(/ownerShortlist/)
        expect(msg).toMatch(/50/)
      }
    })

    test("blockers with 51 entries fails validation", () => {
      const arr = Array.from({ length: 51 }, (_, i) => ({
        what: `b${i}`,
        surface: "type",
      }))
      expect(schema.safeParse({ blockers: arr }).success).toBe(false)
    })

    test("nextStepQueue with 51 entries fails validation", () => {
      const arr = Array.from({ length: 51 }, (_, i) => ({ what: `step${i}` }))
      expect(schema.safeParse({ nextStepQueue: arr }).success).toBe(false)
    })

    test("deferredValidation with 51 entries fails validation", () => {
      const arr = Array.from({ length: 51 }, (_, i) => ({
        rail: `rail${i}`,
        reason: "x",
      }))
      expect(schema.safeParse({ deferredValidation: arr }).success).toBe(false)
    })

    test("exactly 50 entries is accepted (boundary)", () => {
      const arr = Array.from({ length: 50 }, (_, i) => ({
        file: `f${i}.ts`,
        reason: `r${i}`,
      }))
      expect(schema.safeParse({ ownerShortlist: arr }).success).toBe(true)
    })
  })
})

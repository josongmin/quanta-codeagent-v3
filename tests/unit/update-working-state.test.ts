import { describe, expect, test } from "bun:test"
import { createWorkingStateSession } from "@/agent"
import { createUpdateWorkingStateTool, type ToolContext } from "@/tool"

const ctx = (): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
})

const drain = async <I>(
  tool: ReturnType<typeof createUpdateWorkingStateTool>,
  input: I,
): Promise<{ ok: boolean; output: string }> => {
  let result = { ok: false, output: "" }
  for await (const ev of tool.execute(
    input as unknown as Parameters<typeof tool.execute>[0],
    ctx(),
  )) {
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
})

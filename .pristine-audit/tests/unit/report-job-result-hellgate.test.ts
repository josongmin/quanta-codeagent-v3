/**
 * Hellgate — report_agent_job_result batch-worker tool + extraTools seam (GAP7-2).
 *
 * Proves: (a) the capture-once reporter + tool; (b) the SubagentRequest.extraTools
 * seam reaches the child registry; (c) the dispatch PREFERS a reported structured
 * result over final-text parsing, and falls back when the child does not report.
 */
import { describe, expect, test } from "bun:test"
import { buildRowDispatchAdapter } from "@/agent/batch-jobs-dispatch"
import type { SubagentRunner } from "@/subagent"
import { createJobResultReporter, reportJobResultTool } from "@/tool/report-job-result"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal }) as ToolContext
const run = async (
  tool: ReturnType<typeof reportJobResultTool>,
  input: unknown,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

describe("report_agent_job_result — tool + capture-once reporter", () => {
  test("reports a structured result the adapter can read", async () => {
    const cap = createJobResultReporter()
    expect(cap.taken().reported).toBe(false)
    const r = await run(reportJobResultTool(cap.reporter), { result: { score: 9 } })
    expect(r.ok).toBe(true)
    expect(cap.taken()).toEqual({ reported: true, value: { score: 9 } })
  })
  test("any JSON shape; capture-once (2nd rejected, first kept); missing ⇒ ok:false", async () => {
    const cap = createJobResultReporter()
    for (const v of [[1, 2], "x", 42, null]) {
      const c2 = createJobResultReporter()
      await run(reportJobResultTool(c2.reporter), { result: v })
      expect(c2.taken().value).toEqual(v)
    }
    await run(reportJobResultTool(cap.reporter), { result: "first" })
    const r2 = await run(reportJobResultTool(cap.reporter), { result: "second" })
    expect(r2.ok).toBe(false)
    expect(cap.taken().value).toBe("first")
    const c3 = createJobResultReporter()
    expect((await run(reportJobResultTool(c3.reporter), {})).ok).toBe(false)
  })
})

describe("report_agent_job_result — extraTools seam + dispatch preference", () => {
  // A fake runner that runs the injected extraTools' report tool, simulating a
  // child that calls report_agent_job_result with a structured value.
  const reportingRunner =
    (reported: unknown): SubagentRunner =>
    async (req) => {
      const tool = (req.extraTools ?? []).find((t) => t.name === "report_agent_job_result")
      expect(tool).toBeDefined() // seam: the tool reached the child registry
      if (tool) {
        for await (const _ev of tool.execute(
          { result: reported } as never,
          ctx(),
        ) as AsyncIterable<ToolEvent>) {
          // drain — the tool reports into the captured reporter
        }
      }
      return { ok: true, finalText: "ignored free text" } as never
    }

  test("a child that REPORTS ⇒ adapter uses the reported value (NOT finalText)", async () => {
    const adapter = buildRowDispatchAdapter(reportingRunner({ structured: true }))
    const res = await adapter({ instruction: "i", rowJson: "{}", rowIndex: 0, attempt: 1 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.value).toEqual({ structured: true })
  })

  test("a child that does NOT report ⇒ falls back to parseChildValue(finalText)", async () => {
    const silent: SubagentRunner = () =>
      Promise.resolve({ ok: true, finalText: '{"fromText":1}' } as never)
    const res = await buildRowDispatchAdapter(silent)({
      instruction: "i",
      rowJson: "{}",
      rowIndex: 0,
      attempt: 1,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.value).toEqual({ fromText: 1 })
  })
})

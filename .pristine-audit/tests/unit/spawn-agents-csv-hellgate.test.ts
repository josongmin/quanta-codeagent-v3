/**
 * Hellgate — spawn_agents_on_csv tool + BatchRunPort adapter (GAP7-4, ADR-0463).
 *
 * Proves the agent-callable batch fan-out end-to-end over a FAKE SubagentRunner:
 * CSV → one child per row → results CSV. + tool contract + gate.
 */
import { describe, expect, test } from "bun:test"
import { buildInMemoryBatchRunPort } from "@/agent/batch-jobs-dispatch"
import type { SubagentRunner } from "@/subagent"
import { type BatchRunPort, spawnAgentsCsvTool } from "@/tool/spawn-agents-csv"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal }) as ToolContext
const run = async (
  tool: ReturnType<typeof spawnAgentsCsvTool>,
  input: unknown,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

// A fake runner: echoes the row index as the child's final text.
const echoRunner: SubagentRunner = (req) =>
  Promise.resolve({ ok: true, finalText: `processed: ${req.prompt.slice(0, 20)}` } as never)
const CSV = "name,city\nAlice,NYC\nBob,LA\nCarol,SF"

describe("spawn_agents_on_csv — BatchRunPort adapter", () => {
  test("fans one child per row, returns a results CSV summary", async () => {
    const port = buildInMemoryBatchRunPort(echoRunner)
    const r = await port.run({ name: "test", instruction: "greet", csv: CSV, poolSize: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.outcome.total).toBe(3)
    expect(r.outcome.done).toBe(3)
    expect(r.outcome.failed).toBe(0)
    expect(r.outcome.outputCsv).toContain("_status")
    expect(r.outcome.jobId.length).toBeGreaterThan(0)
  })

  test("a failing runner ⇒ rows failed, NOT a thrown batch", async () => {
    const badRunner: SubagentRunner = () =>
      Promise.resolve({ ok: false, finalText: "boom" } as never)
    const r = await buildInMemoryBatchRunPort(badRunner).run({
      name: "t",
      instruction: "x",
      csv: CSV,
      maxAttempts: 1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.failed).toBe(3)
  })

  test("poolSize over the safety cap ⇒ ok:false (cap enforced through the adapter)", async () => {
    const r = await buildInMemoryBatchRunPort(echoRunner).run({
      name: "t",
      instruction: "x",
      csv: CSV,
      poolSize: 9999,
    })
    expect(r.ok).toBe(false)
  })

  test("garbage CSV that yields zero rows ⇒ empty job completes", async () => {
    const r = await buildInMemoryBatchRunPort(echoRunner).run({
      name: "t",
      instruction: "x",
      csv: "onlyheader",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.total).toBe(0)
  })

  test("F1: children dispatch at parentDepth+1 (maxDepth recursion guard engages)", async () => {
    const depths: number[] = []
    const depthRunner: SubagentRunner = (req) => {
      depths.push(req.depth)
      return Promise.resolve({ ok: true, finalText: "x" } as never)
    }
    await buildInMemoryBatchRunPort(depthRunner, 2).run({ name: "t", instruction: "x", csv: CSV })
    expect(depths).toEqual([3, 3, 3]) // parentDepth 2 + 1, NOT a hardcoded 1
  })

  test("F3: an aborted batch ⇒ ok:false (NOT a 0/N-done false success)", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await buildInMemoryBatchRunPort(echoRunner).run(
      { name: "t", instruction: "x", csv: CSV },
      ac.signal,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("abort")
  })
})

describe("spawn_agents_on_csv — tool surface", () => {
  const okPort: BatchRunPort = {
    run: async () => ({
      ok: true,
      outcome: { total: 1, done: 1, failed: 0, outputCsv: "a\n1", jobId: "j1" },
    }),
  }
  test("tool reports the batch summary", async () => {
    const r = await run(spawnAgentsCsvTool(okPort), { name: "t", instruction: "x", csv: CSV })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("1/1 done")
  })
  test("invalid input ⇒ ok:false", async () => {
    const r = await run(spawnAgentsCsvTool(okPort), { instruction: "x", csv: CSV })
    expect(r.ok).toBe(false)
  })
  test("NOT read-only, always-confirm HITL (heavy/cost-bearing)", () => {
    const tool = spawnAgentsCsvTool(okPort)
    expect(tool.isReadOnly?.()).toBe(false)
    expect(tool.hitlTier?.({ name: "t", instruction: "x", csv: CSV })).toBe("always-confirm")
  })
})

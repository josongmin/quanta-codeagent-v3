/**
 * Hellgate — RFC-02 / ADR-0436 `spawn_batch`.
 *
 * Every behavior is driven through the assembled `Tool.execute()` async-
 * generator surface (the same path the agent loop uses) with an INJECTED fake
 * runner + fake readFile + injected clock — no LLM, no disk, no real timers.
 *
 * Covers RFC §9's 12 cases + a default-OFF byte-identical anchor.
 */
import { describe, expect, test } from "bun:test"
import { buildSubagentBatchBlock } from "../../src/agent/tier1/subagent-batch"
import type { AgentConfig } from "../../src/agent/types"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"
import {
  type BatchClock,
  type BatchRunResult,
  type BatchSubagentRequest,
  type BatchSubagentResult,
  type BatchSubagentRunner,
  DEFAULT_BATCH_TIMEOUT_POLICY,
  type SubagentBatchDeps,
  spawnBatchTool,
} from "../../src/tool/subagent-batch"

const ctx = (signal?: AbortSignal): ToolContext =>
  ({ cwd: "/tmp", signal: signal ?? new AbortController().signal }) as ToolContext

/** Drive execute() to completion; return ALL events. */
const driveAll = async (tool: Tool, input: unknown, signal?: AbortSignal): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of tool.execute(input as never, ctx(signal))) events.push(ev)
  return events
}

const lastResult = (
  events: ToolEvent[],
): { ok: boolean; output: string; run: BatchRunResult | undefined } => {
  const last = events.at(-1)
  if (!last || last.type !== "result") throw new Error("expected terminal result event")
  return {
    ok: last.result.ok,
    output: last.result.output,
    run: last.result.structured as BatchRunResult | undefined,
  }
}

/** A controllable fake clock that advances on demand. */
const fakeClock = (): { clock: BatchClock; advance: (ms: number) => void } => {
  let t = 1000
  return { clock: () => t, advance: (ms) => (t += ms) }
}

/** Build deps with a runner + sane defaults. */
const makeDeps = (
  runner: BatchSubagentRunner,
  over: Partial<SubagentBatchDeps> = {},
): SubagentBatchDeps => ({
  runner,
  clock: () => 0,
  maxItems: 256,
  schedulerCap: 8,
  timeoutPolicy: DEFAULT_BATCH_TIMEOUT_POLICY,
  ...over,
})

const ok = (finalText: string, turns = 1): BatchSubagentResult => ({ ok: true, finalText, turns })

describe("spawn_batch — RFC-02 / ADR-0436", () => {
  // 1. N→N
  test("fans out N items to N ok per-item results, index-ordered", async () => {
    const seen: string[] = []
    const runner: BatchSubagentRunner = async (req) => {
      seen.push(req.prompt)
      return ok(`R:${req.prompt}`)
    }
    const tool = spawnBatchTool(makeDeps(runner))
    const { ok: isOk, run } = lastResult(
      await driveAll(tool, {
        items: ["a", "b", "c", "d", "e"],
        prompt_template: "do {{item}}",
      }),
    )
    expect(isOk).toBe(true)
    expect(run?.summary).toMatchObject({ total: 5, ok: 5, failed: 0 })
    expect(run?.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4])
    expect(run?.items.every((i) => i.status === "ok")).toBe(true)
    expect(run?.items[2]?.output).toBe("R:do c")
  })

  // CLI fan-out banner — "Spawning N agents" + per-worker Created lines up front.
  test("emits a 'Spawning N agents' banner (repo + per-worker glyph/id/task)", async () => {
    const tool = spawnBatchTool(makeDeps(async () => ok("x")))
    const events = await driveAll(tool, {
      items: ["reduce core", "reduce runtime"],
      prompt_template: "do {{item}}",
    })
    const banner = events.find(
      (e) => e.type === "progress" && e.message.startsWith("Spawning 2 agents"),
    )
    expect(banner).toBeDefined()
    if (banner?.type === "progress") {
      expect(banner.message).toContain("repo: /tmp")
      expect(banner.message).toContain("Created")
      expect(banner.message).toContain("agent-0")
      expect(banner.message).toContain("Task: reduce core")
    }
  })

  // Batch-wide per-worker controls thread into EVERY child request.
  test("childOptions (isolation/taskKind/resultShape/effort/model) thread to each worker", async () => {
    const reqs: Array<{
      isolation?: string
      taskKind?: string
      resultShape?: string
      effort?: string
      model?: string
    }> = []
    const runner: BatchSubagentRunner = async (req) => {
      reqs.push(req as never)
      return ok("x")
    }
    await driveAll(spawnBatchTool(makeDeps(runner)), {
      items: ["a", "b"],
      prompt_template: "{{item}}",
      isolation: "worktree",
      task_kind: "review",
      result_shape: "JSON {ok}",
      effort: "high",
      model: "gpt-5",
    })
    expect(reqs.length).toBe(2)
    for (const r of reqs) {
      expect(r.isolation).toBe("worktree")
      expect(r.taskKind).toBe("review")
      expect(r.resultShape).toBe("JSON {ok}")
      expect(r.effort).toBe("high")
      expect(r.model).toBe("gpt-5")
    }
  })

  // 2. partial-failure isolation
  test("one item throwing does NOT stop the rest", async () => {
    const runner: BatchSubagentRunner = async (req) => {
      if (req.prompt.includes("c")) throw new Error("boom")
      return ok("fine")
    }
    const tool = spawnBatchTool(makeDeps(runner))
    const { run } = lastResult(
      await driveAll(tool, { items: ["a", "b", "c", "d", "e"], prompt_template: "{{item}}" }),
    )
    expect(run?.summary).toMatchObject({ total: 5, ok: 4, failed: 1 })
    expect(run?.items[2]?.status).toBe("error")
    expect(run?.items[2]?.error).toContain("boom")
    expect(run?.items.filter((i) => i.status === "ok").length).toBe(4)
  })

  // 3. concurrency cap respected
  test("never exceeds max_concurrency in flight; =1 is sequential", async () => {
    let live = 0
    let peak = 0
    const runner: BatchSubagentRunner = async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 1))
      live--
      return ok("x")
    }
    const tool = spawnBatchTool(makeDeps(runner))
    await driveAll(tool, {
      items: Array.from({ length: 12 }, (_, i) => String(i)),
      prompt_template: "{{item}}",
      max_concurrency: 3,
    })
    expect(peak).toBeLessThanOrEqual(3)

    // sequential
    let liveSeq = 0
    let peakSeq = 0
    const runnerSeq: BatchSubagentRunner = async () => {
      liveSeq++
      peakSeq = Math.max(peakSeq, liveSeq)
      await new Promise((r) => setTimeout(r, 1))
      liveSeq--
      return ok("x")
    }
    const toolSeq = spawnBatchTool(makeDeps(runnerSeq))
    await driveAll(toolSeq, {
      items: ["1", "2", "3", "4"],
      prompt_template: "{{item}}",
      max_concurrency: 1,
    })
    expect(peakSeq).toBe(1)
  })

  // 4. empty list
  test("empty items ⇒ ok:true, total 0, zero runner calls", async () => {
    let calls = 0
    const runner: BatchSubagentRunner = async () => {
      calls++
      return ok("x")
    }
    const tool = spawnBatchTool(makeDeps(runner))
    const { ok: isOk, run } = lastResult(
      await driveAll(tool, { items: [], prompt_template: "{{item}}" }),
    )
    expect(isOk).toBe(true)
    expect(run?.summary.total).toBe(0)
    expect(calls).toBe(0)
  })

  // 5. item cap exceeded
  test("items over cap ⇒ ok:false, zero runner calls", async () => {
    let calls = 0
    const runner: BatchSubagentRunner = async () => {
      calls++
      return ok("x")
    }
    const tool = spawnBatchTool(makeDeps(runner, { maxItems: 3 }))
    const { ok: isOk, output } = lastResult(
      await driveAll(tool, { items: ["a", "b", "c", "d"], prompt_template: "{{item}}" }),
    )
    expect(isOk).toBe(false)
    expect(output).toContain("exceeds cap 3")
    expect(calls).toBe(0)
  })

  // 6. template substitution byte-exact + missing-key isolation
  test("templates object items exactly; missing key marks just that item", async () => {
    const prompts: string[] = []
    const runner: BatchSubagentRunner = async (req) => {
      prompts.push(req.prompt)
      return ok("ok")
    }
    const tool = spawnBatchTool(makeDeps(runner))
    const { run } = lastResult(
      await driveAll(tool, {
        items: [
          { a: "x", n: 2 },
          { a: "y" }, // missing n
        ],
        prompt_template: "do {{a}} {{n}} times {{{{lit}}}}",
      }),
    )
    expect(prompts[0]).toBe("do x 2 times {{lit}}")
    expect(run?.items[1]?.status).toBe("error")
    expect(run?.items[1]?.error).toContain("template missing")
    expect(run?.summary).toMatchObject({ ok: 1, failed: 1 })
  })

  // 7. cancel mid-batch
  test("cancellation mid-batch short-circuits not-yet-started items", async () => {
    const ac = new AbortController()
    let started = 0
    const runner: BatchSubagentRunner = async (req: BatchSubagentRequest) => {
      started++
      // After 2 starts, trip the abort, then hang briefly to let the gate close.
      if (started === 2) ac.abort()
      await new Promise((r) => setTimeout(r, 1))
      // child observes abort
      if (req.signal?.aborted) return { ok: false, finalText: "aborted", turns: 0 }
      return ok("x")
    }
    const tool = spawnBatchTool(makeDeps(runner, { schedulerCap: 1 }))
    const { run } = lastResult(
      await driveAll(
        tool,
        { items: ["1", "2", "3", "4", "5"], prompt_template: "{{item}}", max_concurrency: 1 },
        ac.signal,
      ),
    )
    // Some items never started ("cancelled before start").
    const cancelledBeforeStart = run?.items.filter(
      (i) => i.error === "cancelled before start",
    ).length
    expect(cancelledBeforeStart ?? 0).toBeGreaterThan(0)
    expect(run?.summary.total).toBe(5)
  })

  // 8. worker hang → per-item timeout
  test("hanging worker hits per_item_timeout_ms; others continue", async () => {
    const fc = fakeClock()
    const runner: BatchSubagentRunner = async (req) => {
      if (req.prompt === "hang") {
        // never resolves on its own; only the timeout abort ends it.
        return await new Promise<BatchSubagentResult>((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }
      return ok("fast")
    }
    const tool = spawnBatchTool(
      makeDeps(runner, {
        clock: fc.clock,
        timeoutPolicy: { minMs: 1, maxMs: 1_000_000, defaultMs: 50 },
      }),
    )
    const promise = driveAll(tool, {
      items: ["hang", "ok1"],
      prompt_template: "{{item}}",
      per_item_timeout_ms: 50,
    })
    // give the event loop a tick so the timeout timer is armed, then let it fire.
    const events = await promise
    const { run } = lastResult(events)
    const hangItem = run?.items.find((i) => i.id === "0")
    expect(hangItem?.status).toBe("error")
    expect(hangItem?.error).toContain("timed out")
    expect(run?.items.find((i) => i.id === "1")?.status).toBe("ok")
  })

  // 9. output_schema violation isolated
  test("output_schema violation marks only the offending item", async () => {
    const runner: BatchSubagentRunner = async (req) => {
      if (req.prompt === "bad") return ok('{"other": 1}') // missing "result"
      return ok('{"result": "good"}')
    }
    const tool = spawnBatchTool(makeDeps(runner))
    const { run } = lastResult(
      await driveAll(tool, {
        items: ["good", "bad"],
        prompt_template: "{{item}}",
        output_schema: { result: "string" },
      }),
    )
    expect(run?.items[0]?.status).toBe("ok")
    expect(run?.items[0]?.parsed).toEqual({ result: "good" })
    expect(run?.items[1]?.status).toBe("error")
    expect(run?.items[1]?.error).toContain("output_schema violation")
  })

  // 10. default-OFF byte-identical
  test("default-OFF: enableBatchSpawn absent ⇒ tier1 builder returns []", async () => {
    const base = { cwd: "/tmp" } as AgentConfig
    expect(buildSubagentBatchBlock(base)).toEqual([])
    expect(buildSubagentBatchBlock({ ...base, subagent: {} } as AgentConfig)).toEqual([])
    expect(
      buildSubagentBatchBlock({ ...base, subagent: { enableBatchSpawn: false } } as AgentConfig),
    ).toEqual([])
    // enabled ⇒ exactly one tool named spawn_batch
    const enabled = buildSubagentBatchBlock({
      ...base,
      subagent: { enableBatchSpawn: true },
    } as AgentConfig)
    expect(enabled.map((t) => t.name)).toEqual(["spawn_batch"])
  })

  // 11. items XOR items_path
  test("both items and items_path ⇒ ok:false; neither ⇒ ok:false", async () => {
    const runner: BatchSubagentRunner = async () => ok("x")
    const tool = spawnBatchTool(makeDeps(runner, { readFile: async () => "" }))
    const both = lastResult(
      await driveAll(tool, {
        items: ["a"],
        items_path: "/x.json",
        prompt_template: "{{item}}",
      }),
    )
    expect(both.ok).toBe(false)
    expect(both.output).toContain("exactly one")
    const neither = lastResult(await driveAll(tool, { prompt_template: "{{item}}" }))
    expect(neither.ok).toBe(false)
    expect(neither.output).toContain("exactly one")
  })

  // 12. csv parsing
  test("csv items_path: header + quoted/comma-escaped rows parse to objects", async () => {
    const csv = 'name,note\nalice,"hello, world"\nbob,"say ""hi"""\n'
    const prompts: string[] = []
    const runner: BatchSubagentRunner = async (req) => {
      prompts.push(req.prompt)
      return ok("ok")
    }
    const tool = spawnBatchTool(makeDeps(runner, { readFile: async () => csv }))
    const { run } = lastResult(
      await driveAll(tool, { items_path: "/in.csv", prompt_template: "{{name}}: {{note}}" }),
    )
    expect(run?.summary.total).toBe(2)
    expect(prompts).toEqual(["alice: hello, world", 'bob: say "hi"'])
  })

  // extra: all-failed ⇒ ok:false
  test("all items failing surfaces ok:false", async () => {
    const runner: BatchSubagentRunner = async () => ({ ok: false, finalText: "nope", turns: 1 })
    const tool = spawnBatchTool(makeDeps(runner))
    const { ok: isOk, run } = lastResult(
      await driveAll(tool, { items: ["a", "b"], prompt_template: "{{item}}" }),
    )
    expect(isOk).toBe(false)
    expect(run?.summary).toMatchObject({ ok: 0, failed: 2 })
  })

  // extra: jsonl + json array loaders
  test("jsonl and json-array items_path load object items", async () => {
    const runner: BatchSubagentRunner = async () => ok("ok")
    const jsonl = spawnBatchTool(makeDeps(runner, { readFile: async () => '{"x":1}\n{"x":2}\n' }))
    const r1 = lastResult(
      await driveAll(jsonl, { items_path: "/a.jsonl", prompt_template: "{{x}}" }),
    )
    expect(r1.run?.summary.total).toBe(2)

    const jarr = spawnBatchTool(
      makeDeps(runner, { readFile: async () => '[{"x":1},{"x":2},{"x":3}]' }),
    )
    const r2 = lastResult(await driveAll(jarr, { items_path: "/a.json", prompt_template: "{{x}}" }))
    expect(r2.run?.summary.total).toBe(3)
  })
})

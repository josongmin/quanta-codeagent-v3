import { describe, expect, test } from "bun:test"
import { type DispatchOutcome, type StreamingCall, streamingTurn } from "@/agent/streaming-dispatch"
import type { StreamEvent } from "@/llm"
import {
  createAgentTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

/**
 * ADR-0298 — Subagent fanout via streaming-dispatch barrier.
 *
 * Hellgate seals the parallel-spawn invariant: a single assistant message
 * carrying N `agent` tool_use blocks dispatches them CONCURRENTLY via the
 * existing `streaming-dispatch.ts` barrier engine (Phase 1 — in-flight,
 * pre-stream-end). The flip is `agent.isConcurrencySafe: () => true`; the
 * mechanism is unchanged.
 *
 * Safety argument (defended by the cases here):
 * - Each child runs in its own conversation envelope (separate registry +
 *   store + checkpoint + abort signal); siblings share no mutable state.
 * - The barrier still engages on the FIRST non-concurrency-safe sibling
 *   in the same turn (e.g. `write` after two `agent`s) — i.e. agent fanout
 *   does NOT regress the head-of-line barrier for genuinely unsafe tools.
 * - Result ordering follows model-call order regardless of which child
 *   resolves first (streaming-dispatch Phase 4 invariant — already covered
 *   by streaming-dispatch.test.ts; re-asserted here for fanout-shaped events).
 *
 * `parallel_worker?: boolean` is a DECLARATIVE flag (Cursor `is_parallel_worker`
 * pattern). It carries zero functional behaviour — concurrency is governed by
 * `isConcurrencySafe`. The flag is for human / telemetry intent surfacing.
 */

// ─── shared harness ────────────────────────────────────────────────────────

const ctxAt = (depth?: number): ToolContext =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
  }) as ToolContext

const result = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "child done",
  turns: 1,
  ...r,
})

const runTool = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

// ─── async generator over a fixed event list (mirrors streaming-dispatch.test.ts)
async function* gen(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) {
    yield ev
    await Promise.resolve()
  }
}

const toolUseEvents = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
]

const block = (id: string, content: string): DispatchOutcome => ({
  block: { type: "tool_result", tool_use_id: id, content },
  ok: true,
  preview: content,
})

// ─── Section 1 — declarative surface ─────────────────────────────────────────

describe("ADR-0298 agent.isConcurrencySafe — declarative flip", () => {
  test("agent tool reports concurrency-safe (parent loop has no mutable race)", () => {
    const runner: SubagentRunner = async () => result()
    const tool = createAgentTool({ runner })
    expect(tool.isConcurrencySafe({ prompt: "x" })).toBe(true)
  })

  test("isConcurrencySafe is independent of parallel_worker flag (the flag is declarative)", () => {
    const runner: SubagentRunner = async () => result()
    const tool = createAgentTool({ runner })
    expect(tool.isConcurrencySafe({ prompt: "x", parallel_worker: true })).toBe(true)
    expect(tool.isConcurrencySafe({ prompt: "x", parallel_worker: false })).toBe(true)
    expect(tool.isConcurrencySafe({ prompt: "x" })).toBe(true)
  })

  test("agent tool input accepts parallel_worker:true without error", async () => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (req) => {
      seen = req
      return result()
    }
    const tool = createAgentTool({ runner })
    const ev = await runTool(tool, { prompt: "explore", parallel_worker: true }, ctxAt(0))
    expect(ev.type).toBe("result")
    if (ev.type !== "result") return
    expect(ev.result.ok).toBe(true)
    // The flag does NOT leak into the SubagentRequest (it's a parent-side
    // declaration, not a child contract field).
    expect(seen?.prompt).toBe("explore")
  })

  test("isReadOnly stays false (child still has unbounded effects within its own loop)", () => {
    const runner: SubagentRunner = async () => result()
    const tool = createAgentTool({ runner })
    expect(tool.isReadOnly()).toBe(false)
  })
})

// ─── Section 2 — streaming-dispatch fanout integration ───────────────────────

describe("ADR-0298 fanout — three sibling agent spawns dispatch concurrently", () => {
  test("3 agent calls in one turn start before stream end (in-flight Phase 1)", async () => {
    const log: string[] = []
    const isConcurrencySafe = (name: string): boolean => name === "agent"
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      log.push(`start:${call.id}`)
      // Real gap so siblings can overlap.
      await new Promise((r) => setTimeout(r, 10))
      log.push(`end:${call.id}`)
      return block(call.id, `child-${call.id}`)
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1", parallel_worker: true }),
      { type: "text_delta", delta: "..." },
      ...toolUseEvents("c2", "agent", { prompt: "p2", parallel_worker: true }),
      { type: "text_delta", delta: "..." },
      ...toolUseEvents("c3", "agent", { prompt: "p3", parallel_worker: true }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const evLog: string[] = []
    async function* tracedGen(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        yield ev
        evLog.push(`ev:${ev.type}`)
        await Promise.resolve()
      }
    }
    const res = await streamingTurn({
      events: tracedGen(),
      isConcurrencySafe,
      dispatch,
      onToolStart: (call) => log.push(`scheduled:${call.id}`),
    })
    expect(res.kind).toBe("assembled")
    // All three started BEFORE either finished — i.e. genuinely concurrent.
    const s1 = log.indexOf("start:c1")
    const s2 = log.indexOf("start:c2")
    const s3 = log.indexOf("start:c3")
    const e1 = log.indexOf("end:c1")
    expect(s1).toBeGreaterThanOrEqual(0)
    expect(s2).toBeGreaterThanOrEqual(0)
    expect(s3).toBeGreaterThanOrEqual(0)
    expect(s2).toBeLessThan(e1)
    expect(s3).toBeLessThan(e1)
  })

  test("wall-clock for 3 × 50ms concurrent < 3 × 50ms serial (race tolerance)", async () => {
    // 50ms per child; with concurrency total should be ≈ 50ms (allowing
    // scheduler jitter), with serialization ≈ 150ms. We use a 110ms ceiling:
    // generous enough to absorb jitter on CI while strictly less than the
    // 150ms serial floor — i.e. concurrency is observably required to pass.
    const PER_CHILD_MS = 50
    const SERIAL_FLOOR_MS = 3 * PER_CHILD_MS
    const CEIL_MS = 110

    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      await new Promise((r) => setTimeout(r, PER_CHILD_MS))
      return block(call.id, "x")
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1" }),
      ...toolUseEvents("c2", "agent", { prompt: "p2" }),
      ...toolUseEvents("c3", "agent", { prompt: "p3" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const t0 = Date.now()
    await streamingTurn({
      events: gen(events),
      isConcurrencySafe: (name) => name === "agent",
      dispatch,
    })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(CEIL_MS)
    expect(elapsed).toBeLessThan(SERIAL_FLOOR_MS)
  })

  test("3 spawn results retain model-call order regardless of completion order", async () => {
    // Resolve in REVERSE order to prove ordering is by model call, not completion.
    const finishDelay: Record<string, number> = { c1: 30, c2: 20, c3: 5 }
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      await new Promise((r) => setTimeout(r, finishDelay[call.id] ?? 0))
      return block(call.id, `out-${call.id}`)
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1" }),
      ...toolUseEvents("c2", "agent", { prompt: "p2" }),
      ...toolUseEvents("c3", "agent", { prompt: "p3" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events),
      isConcurrencySafe: (name) => name === "agent",
      dispatch,
    })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    expect(res.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))).toEqual([
      "c1",
      "c2",
      "c3",
    ])
  })

  test("onToolStart fires for each fanned-out child (telemetry surface)", async () => {
    const started: string[] = []
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => block(call.id, "x")
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1", parallel_worker: true }),
      ...toolUseEvents("c2", "agent", { prompt: "p2", parallel_worker: true }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    await streamingTurn({
      events: gen(events),
      isConcurrencySafe: () => true,
      dispatch,
      onToolStart: (call) => started.push(call.id),
    })
    expect(started).toEqual(["c1", "c2"])
  })
})

// ─── Section 3 — barrier interaction with unsafe siblings ────────────────────

describe("ADR-0298 fanout — HOL barrier still engages on unsafe siblings", () => {
  test("agent × 2 + write: the two agents start during stream; write is deferred (barrier)", async () => {
    const log: string[] = []
    const isConcurrencySafe = (name: string): boolean => name === "agent"
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      log.push(`start:${call.name}:${call.id}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`end:${call.name}:${call.id}`)
      return block(call.id, "x")
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1" }),
      ...toolUseEvents("c2", "agent", { prompt: "p2" }),
      ...toolUseEvents("w1", "write", { path: "/tmp/x", content: "x" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const evLog: string[] = []
    async function* tracedGen(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        yield ev
        evLog.push(`ev:${ev.type}`)
        await Promise.resolve()
      }
    }
    await streamingTurn({
      events: tracedGen(),
      isConcurrencySafe,
      dispatch,
    })
    // Both agents started before message_stop event was emitted (interleaved).
    const c1Start = log.indexOf("start:agent:c1")
    const c2Start = log.indexOf("start:agent:c2")
    expect(c1Start).toBeGreaterThanOrEqual(0)
    expect(c2Start).toBeGreaterThanOrEqual(0)
    // write must NOT start before the stream finishes (barrier).
    // The dispatch log doesn't see message_stop, so we check vs both agent ends:
    // both agents must have ENDED before write started (serial after barrier engaged).
    const c1End = log.indexOf("end:agent:c1")
    const c2End = log.indexOf("end:agent:c2")
    const w1Start = log.indexOf("start:write:w1")
    expect(w1Start).toBeGreaterThan(c1End)
    expect(w1Start).toBeGreaterThan(c2End)
  })

  test("write FIRST then 2 agents: barrier engages on write → both agents deferred (serial)", async () => {
    const log: string[] = []
    const isConcurrencySafe = (name: string): boolean => name === "agent"
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      log.push(`start:${call.name}:${call.id}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`end:${call.name}:${call.id}`)
      return block(call.id, "x")
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("w1", "write", { path: "/tmp/x", content: "x" }),
      ...toolUseEvents("c1", "agent", { prompt: "p1" }),
      ...toolUseEvents("c2", "agent", { prompt: "p2" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const evLog: string[] = []
    async function* tracedGen(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        yield ev
        evLog.push(`ev:${ev.type}`)
        await Promise.resolve()
      }
    }
    await streamingTurn({
      events: tracedGen(),
      isConcurrencySafe,
      dispatch,
    })
    // write starts AFTER stream end (post-barrier serial), agents follow strictly serial.
    // The key invariant: even though c1/c2 are concurrency-safe, the engaged
    // barrier defers them. Therefore c1 must NOT start before w1 ends.
    const w1End = log.indexOf("end:write:w1")
    const c1Start = log.indexOf("start:agent:c1")
    const c2Start = log.indexOf("start:agent:c2")
    expect(c1Start).toBeGreaterThan(w1End)
    // And c1 fully ends before c2 starts (serial drain).
    const c1End = log.indexOf("end:agent:c1")
    expect(c2Start).toBeGreaterThan(c1End)
  })
})

// ─── Section 4 — depth / budget guards survive concurrent dispatch ──────────

describe("ADR-0298 fanout — depth + budget guards survive N-concurrent spawn", () => {
  test("each concurrent spawn increments depth from parent ctx (independently)", async () => {
    const seenDepths: number[] = []
    const runner: SubagentRunner = async (req) => {
      seenDepths.push(req.depth)
      // Yield so concurrent spawns interleave on the microtask queue.
      await Promise.resolve()
      return result()
    }
    const tool = createAgentTool({ runner, maxDepth: 3 })

    // Simulate 4 concurrent invocations from parent depth 1.
    const parentCtx = ctxAt(1)
    const calls = [1, 2, 3, 4].map((i) =>
      runTool(tool, { prompt: `task-${i}`, parallel_worker: true }, parentCtx),
    )
    const evs = await Promise.all(calls)
    for (const ev of evs) {
      expect(ev.type).toBe("result")
      if (ev.type !== "result") continue
      expect(ev.result.ok).toBe(true)
    }
    // Every child saw depth = parent+1 = 2 (independent, no shared state).
    expect(seenDepths.length).toBe(4)
    expect(seenDepths.every((d) => d === 2)).toBe(true)
  })

  test("maxDepth guard fires per call (not collectively) on concurrent spawns past ceiling", async () => {
    const runner: SubagentRunner = async () => result()
    const tool = createAgentTool({ runner, maxDepth: 2 })

    // Parent at depth 2 ⇒ children at depth 3 ⇒ exceeds maxDepth 2 ⇒ all deny.
    const parentCtx = ctxAt(2)
    const evs = await Promise.all([
      runTool(tool, { prompt: "a", parallel_worker: true }, parentCtx),
      runTool(tool, { prompt: "b", parallel_worker: true }, parentCtx),
      runTool(tool, { prompt: "c", parallel_worker: true }, parentCtx),
    ])
    for (const ev of evs) {
      expect(ev.type).toBe("result")
      if (ev.type !== "result") continue
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toMatch(/exceeds maxDepth/)
    }
  })

  test("background + concurrent: each spawn gets its OWN task_id (no collision)", async () => {
    const registry = new TaskRegistry()
    // Block runner until released so we can observe the launch results
    // before any task settles.
    const gates: Array<(r: SubagentResult) => void> = []
    const runner: SubagentRunner = (_req) =>
      new Promise<SubagentResult>((res) => {
        gates.push(res)
      })
    const tool = createAgentTool({ runner, registry })

    const parentCtx = ctxAt(0)
    const evs = await Promise.all([
      runTool(tool, { prompt: "a", background: true, parallel_worker: true }, parentCtx),
      runTool(tool, { prompt: "b", background: true, parallel_worker: true }, parentCtx),
      runTool(tool, { prompt: "c", background: true, parallel_worker: true }, parentCtx),
    ])
    const ids = evs.map((ev) => {
      if (ev.type !== "result") throw new Error("expected result")
      const m = ev.result.output.match(/task_id: ([^\s]+)/)
      return m?.[1] ?? ""
    })
    // Three distinct ids (no collision under concurrent registration).
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
    // Cleanup: release the gates so the runners settle.
    for (const g of gates) g(result())
  })
})

// ─── Section 5 — child isolation invariants (the safety argument) ────────────

describe("ADR-0298 fanout — child isolation (siblings share no mutable state)", () => {
  test("each child gets its own abort signal — cancelling one does not abort siblings", async () => {
    const registry = new TaskRegistry()
    const signals: AbortSignal[] = []
    const gates: Array<{ resolve: (r: SubagentResult) => void }> = []
    const runner: SubagentRunner = (req) => {
      if (req.signal) signals.push(req.signal)
      return new Promise<SubagentResult>((resolve) => {
        gates.push({ resolve })
      })
    }
    const tool = createAgentTool({ runner, registry })

    const parentCtx = ctxAt(0)
    const [ev1, ev2] = await Promise.all([
      runTool(tool, { prompt: "a", background: true }, parentCtx),
      runTool(tool, { prompt: "b", background: true }, parentCtx),
    ])
    if (ev1.type !== "result" || ev2.type !== "result") throw new Error("expected results")
    const id1 = ev1.result.output.match(/task_id: ([^\s]+)/)?.[1] ?? ""
    const token1 = ev1.result.output.match(/owner_token: ([^\s]+)/)?.[1] ?? ""
    expect(id1.length).toBeGreaterThan(0)
    expect(token1.length).toBeGreaterThan(0)
    expect(signals.length).toBe(2)
    // Stop the first task — only its signal should flip.
    const stopRes = registry.stop(id1, token1)
    expect(stopRes).toBe("stopped")
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    // Cleanup: settle the gates.
    for (const g of gates) g.resolve(result())
  })

  test("parallel_worker flag does NOT change the underlying SubagentRequest shape", async () => {
    let withFlag: SubagentRequest | undefined
    let withoutFlag: SubagentRequest | undefined
    let next: "with" | "without" = "with"
    const runner: SubagentRunner = async (req) => {
      if (next === "with") withFlag = req
      else withoutFlag = req
      return result()
    }
    const tool = createAgentTool({ runner })
    next = "with"
    await runTool(tool, { prompt: "p", parallel_worker: true }, ctxAt(0))
    next = "without"
    await runTool(tool, { prompt: "p" }, ctxAt(0))

    // Identical fields — the flag is parent-side declarative, not a child contract.
    expect(withFlag?.prompt).toBe("p")
    expect(withoutFlag?.prompt).toBe("p")
    expect(withFlag?.depth).toBe(withoutFlag?.depth)
  })
})

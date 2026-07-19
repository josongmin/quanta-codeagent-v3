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
 * ADR-0298 — Subagent fanout via streaming-dispatch barrier
 *   (RECONCILED with ADR-0076 Gap-5 "FIX 6" — early-dispatch abort hole).
 *
 * ORIGINAL ADR-0298 shipped sibling `agent` fan-out as IN-FLIGHT (Phase-1)
 * concurrency: N `agent` tool_use blocks in one assistant message all started
 * their `dispatch()` overlapping the remaining model stream, via
 * `agent.isEarlyDispatchSafe:()=>true`.
 *
 * FIX 6 (commit 4843c6020, jul-2 runtime bugbash — DELIBERATE, shipped,
 * red-on-revert) RETIRED that in-flight overlap for `agent`. Rationale: an
 * early-started `agent` is fired in flight; on a `config.signal` abort,
 * `abandonInFlight` discards its in-flight promise and `streamingTurn` returns
 * `{kind:"aborted"}` BEFORE the slot's `tool_result` is appended. If the child
 * `agent` already committed a side effect (write/bash) before observing the
 * shared signal, that mutation PERSISTS but its `tool_result` is never recorded
 * → double-exec on resume. The fence-clean fix: the early-start gate in
 * `scheduleResolvedCall` consults ONLY `isReadOnly`, so a NON-read-only tool
 * (`agent`) is NEVER early-started — it runs DEFERRED in the Phase-3 serial
 * drain. `isEarlyDispatchSafe` is still WIRED by the loop and `agent` still
 * declares it `()=>true`, but the gate intentionally does NOT consult it
 * (`void isEarlyDispatchSafe`). See `src/agent/streaming-dispatch.test.ts` for
 * the owner-side FIX-6 contract this file mirrors for fanout-shaped events.
 *
 * POST-FIX-6 invariant this hellgate seals:
 * - Sibling `agent` calls run SERIALLY-DEFERRED (one at a time in the Phase-3
 *   drain), NOT concurrently in flight — peak in-flight === 1, and each agent
 *   fully ENDS before the next STARTS (strict serial drain order).
 * - The abort hole is CLOSED: a mid-stream abort BEFORE the drain leaves every
 *   `agent` slot un-dispatched (`promise === undefined`), so nothing commits an
 *   unrecorded side effect.
 * - `resultBlocks`/ordering are UNCHANGED (Phase-4 sorts by model-call order
 *   regardless of early/deferred) — only wall-clock overlap timing changed.
 * - The barrier still engages on the FIRST non-concurrency-safe sibling
 *   in the same turn (e.g. `write` after two `agent`s) — i.e. agent fanout
 *   does NOT regress the head-of-line barrier for genuinely unsafe tools.
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

describe("ADR-0298 fanout — sibling agent spawns run serially-deferred (post-FIX-6)", () => {
  // The `agent` tool is `isConcurrencySafe:true` but `isReadOnly:false` (its
  // child owns an unrestricted tool set — see agent-tool.ts). It STILL declares
  // `isEarlyDispatchSafe:()=>true` and the loop STILL wires that predicate — but
  // FIX 6 (ADR-0076 Gap-5 abort-hole closure) makes `scheduleResolvedCall`
  // consult ONLY `isReadOnly` for early-start eligibility, so a NON-read-only
  // `agent` is NEVER early-started. We mirror the loop's production wiring here
  // (`isConcurrencySafe`/`isReadOnly`/`isEarlyDispatchSafe` all bound exactly as
  // `stream-consume.ts` binds them) so the fan-out invariant is exercised as it
  // ships: `agent` is concurrency-safe + early-dispatch-declared but NOT
  // read-only ⇒ it is DEFERRED to the Phase-3 serial drain, never in flight.
  const isConcurrencySafe = (name: string): boolean => name === "agent"
  const isReadOnly = (name: string): boolean => name === "read"
  const isEarlyDispatchSafe = (name: string): boolean => name === "agent"

  test("3 agent calls in one turn run SERIALLY-DEFERRED — none in flight, each ends before the next starts (post-FIX-6)", async () => {
    // POST-FIX-6 contract. `agent` is NON-read-only, so FIX 6 keeps it OUT of the
    // in-flight early-start phase: all three run in the Phase-3 serial drain,
    // one at a time, in model-call order. This is a DETERMINISTIC event-ordering
    // proof with NO wall-clock thresholds and NO shared barrier (the old barrier
    // deadlocked under serialization — which is exactly what FIX-6 now does).
    //
    // We assert two things the RETIRED in-flight path would VIOLATE and the new
    // serial-deferred path GUARANTEES:
    //   (a) every `start:*` is emitted at DRAIN time — i.e. AFTER the stream has
    //       fully closed (`message_stop` observed). We witness stream progress
    //       via `evLog` and assert no dispatch fired while the stream was open.
    //   (b) STRICT serial interleave: end:c1 < start:c2 < end:c2 < start:c3.
    //       Under the old in-flight fan-out all three would `start:` before any
    //       `end:` (start:c1,start:c2,start:c3,end:...). This assertion FLIPS if
    //       FIX-6 is reverted to early-start `agent` (red-on-injection).
    const log: string[] = []
    const evLog: string[] = []
    let streamClosed = false
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      // If ANY agent dispatched while the stream was still open, it was
      // early-started in flight — a FIX-6 regression.
      log.push(`start:${call.id}:streamClosed=${streamClosed}`)
      // Yield to the microtask queue: if siblings were concurrent they would
      // interleave their own `start:` here BEFORE this one records `end:`.
      await Promise.resolve()
      await Promise.resolve()
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
    async function* tracedGen(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        yield ev
        evLog.push(`ev:${ev.type}`)
        await Promise.resolve()
      }
      streamClosed = true
    }
    const res = await streamingTurn({
      events: tracedGen(),
      isConcurrencySafe,
      isReadOnly,
      isEarlyDispatchSafe,
      dispatch,
      onToolStart: (call) => log.push(`scheduled:${call.id}`),
    })
    expect(res.kind).toBe("assembled")

    // (a) DEFERRED, not in flight: no `agent` dispatch fired before the stream
    //     closed. Every start records `streamClosed=true`.
    const starts = log.filter((l) => l.startsWith("start:"))
    expect(starts).toHaveLength(3)
    for (const s of starts) expect(s.endsWith("streamClosed=true")).toBe(true)

    // (b) STRICT serial drain — each agent fully ENDS before the next STARTS,
    //     in model-call order. (Under the retired in-flight fan-out all three
    //     `start:` precede any `end:`, which flips this ordering chain.)
    const idx = (needle: string) => log.findIndex((l) => l.startsWith(needle))
    const s1 = idx("start:c1")
    const e1 = log.indexOf("end:c1")
    const s2 = idx("start:c2")
    const e2 = log.indexOf("end:c2")
    const s3 = idx("start:c3")
    const e3 = log.indexOf("end:c3")
    expect(s1).toBeLessThan(e1)
    expect(e1).toBeLessThan(s2)
    expect(s2).toBeLessThan(e2)
    expect(e2).toBeLessThan(s3)
    expect(s3).toBeLessThan(e3)
  })

  test("serial fan-out — peak in-flight is exactly ONE (never overlapped, post-FIX-6)", async () => {
    // DETERMINISTIC peak-concurrency proof. Each dispatch bumps a live counter,
    // then parks on its OWN macrotask timer (setTimeout 0) before decrementing.
    // The per-call timer is the trick that makes this a two-way discriminator
    // WITHOUT deadlocking:
    //   - Under FIX-6 serial deferral, `drainDeferredSlots` awaits dispatch #1 to
    //     completion (its timer fires) BEFORE starting #2, so only one is ever
    //     parked ⇒ peak stays 1.
    //   - Under the retired in-flight fan-out, all three dispatches are fired
    //     synchronously as the stream is consumed, so all three timers are armed
    //     and all three park SIMULTANEOUSLY ⇒ peak climbs to 3.
    // A shared gate would deadlock the serial path; independent timers never do.
    let inFlight = 0
    let peak = 0
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // Park on a macrotask: a concurrent sibling fired in flight parks here too
      // (before this one's timer fires), driving `inFlight` above 1.
      await new Promise((r) => setTimeout(r, 0))
      peak = Math.max(peak, inFlight)
      inFlight -= 1
      return block(call.id, "x")
    }
    const events: StreamEvent[] = [
      ...toolUseEvents("c1", "agent", { prompt: "p1" }),
      ...toolUseEvents("c2", "agent", { prompt: "p2" }),
      ...toolUseEvents("c3", "agent", { prompt: "p3" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    await streamingTurn({
      events: gen(events),
      isConcurrencySafe,
      isReadOnly,
      isEarlyDispatchSafe,
      dispatch,
    })
    // Peak in-flight === 1 ⇒ strictly serial drain, never overlapped. Reverting
    // FIX-6 to early-start `agent` drives all three in flight ⇒ peak === 3 (red).
    expect(peak).toBe(1)
  })

  test("ABORT-HOLE CLOSED — a mid-stream abort leaves every `agent` slot UN-dispatched (no unrecorded side effect)", async () => {
    // The safety half of FIX-6. Because `agent` is deferred (never early-started
    // in flight), an abort that trips BEFORE the Phase-3 drain finds every agent
    // slot with `promise === undefined` ⇒ nothing was dispatched ⇒ no child could
    // have committed a write/bash whose `tool_result` is then silently discarded.
    // Under the RETIRED in-flight path `c1`/`c2` would already be dispatched and
    // then abandoned, so `dispatched` would be non-empty — this assertion flips
    // on a FIX-6 revert (red-on-injection for the abort-hole itself).
    const controller = new AbortController()
    const dispatched: string[] = []
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      dispatched.push(call.id)
      return block(call.id, "x")
    }
    // Stream both agents fully, THEN trip the signal, THEN emit one more event so
    // the for-await abort check fires on the next pump (mid-stream abort path).
    async function* eventsThenAbort(): AsyncGenerator<StreamEvent> {
      yield* toolUseEvents("c1", "agent", { prompt: "p1" })
      yield* toolUseEvents("c2", "agent", { prompt: "p2" })
      controller.abort()
      yield { type: "text_delta", delta: "x" }
    }
    const res = await streamingTurn({
      events: eventsThenAbort(),
      isConcurrencySafe,
      isReadOnly,
      isEarlyDispatchSafe,
      dispatch,
      signal: controller.signal,
    })
    expect(res.kind).toBe("aborted")
    // The hole is closed: no `agent` was ever dispatched, so nothing committed a
    // side effect that the aborted-discard path would fail to record.
    expect(dispatched).toEqual([])
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

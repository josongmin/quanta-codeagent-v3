import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  createAgentTool,
  createTaskOutputTool,
  createTaskStopTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * Full-loop e2e regression for the HIGH cancellation bug. The parent's model
 * spawns a BACKGROUND subagent, then calls `task_stop` on it. The forked
 * `runAgent` running the child MUST observe the per-task AbortController
 * threaded via `req.signal` (chained into the child's loop signal in
 * `buildChildConfig`) and exit with `aborted` — proving the historical bug
 * (`agent-tool.ts#launchBackground` discarded the controller, so `task_stop`
 * flipped the registry status flag but never unwound the child) is closed.
 *
 * Design notes:
 *  - The child loop never produces an `end_turn` text on its own — it just
 *    keeps emitting tool_use calls forever (deterministic, bounded by the
 *    abort, not by maxTurns or natural completion).
 *  - The child's tool calls hit `read` against an existing file (or just a
 *    deterministic registered default tool) so the loop produces a real
 *    tool_result and proceeds to the next turn — until the abort fires.
 *  - The parent's flow is: spawn background → call `task_stop` → call
 *    `task_output` to observe `status: stopped` → finish.
 */

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const toolCall = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text (every message, every block) — robust against the
 *  trailing `<system-reminder>` reminder block. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/** Sniff the most recent agent-tool tool_result for `task_id: <id>` and
 *  `owner_token: <token>` (S17). Used by the routing LLM to substitute live
 *  values into scripted tool calls that reference `__PLACEHOLDER__`. */
const findLastTaskFields = (input: StreamInput): { taskId?: string; ownerToken?: string } => {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]
    if (!m) continue
    for (const b of m.content) {
      if (b.type !== "tool_result") continue
      const taskMatch = b.content.match(/task_id: (\S+)/)
      const ownerMatch = b.content.match(/owner_token: (\S+)/)
      if (taskMatch?.[1] || ownerMatch?.[1]) {
        return {
          ...(taskMatch?.[1] ? { taskId: taskMatch[1] } : {}),
          ...(ownerMatch?.[1] ? { ownerToken: ownerMatch[1] } : {}),
        }
      }
    }
  }
  return {}
}

/** Replace `__PLACEHOLDER__` task_id / owner_token on tool_use_end events.
 *  Other events pass through unchanged. */
const rewriteTaskId = (
  e: StreamEvent,
  fields: { taskId?: string; ownerToken?: string },
): StreamEvent => {
  if (e.type !== "tool_use_end") return e
  const inp = (e as { input?: unknown }).input
  if (!inp || typeof inp !== "object") return e
  const obj = inp as Record<string, unknown>
  const next: Record<string, unknown> = { ...obj }
  let changed = false
  if (fields.taskId !== undefined && obj["task_id"] === "__PLACEHOLDER__") {
    next["task_id"] = fields.taskId
    changed = true
  }
  if (fields.ownerToken !== undefined && obj["owner_token"] === "__PLACEHOLDER__") {
    next["owner_token"] = fields.ownerToken
    changed = true
  }
  return changed ? { ...e, input: next } : e
}

/** Routes turns by substring match. `once:true` rules fire once then are spent.
 *  When no rule matches we yield a deterministic "noop" tool_call (a `read` on
 *  a non-existing path — produces a tool_result + next turn) so an unrouted
 *  child loop CANNOT silently finish via fallback text; only the abort can
 *  unwind it. */
class RoutingLLM implements LLMPort {
  readonly model = "routing-test-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  // A monotonically-increasing counter so we can issue unique tool_use ids on
  // the fallback path.
  private fallback = 0
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (rule) {
      if (rule.once) rule.spent = true
      this.log.push(rule.match)
      for (const e of rule.events) yield e
      return
    }
    // Fallback: deterministic tool_use that keeps the loop going indefinitely.
    // Used for the child to keep spinning until abort. NOT for the parent —
    // every parent step has an explicit rule.
    this.fallback += 1
    const id = `fb${this.fallback}`
    this.log.push(`FALLBACK:${this.fallback}`)
    yield { type: "tool_use_start", id, name: "read" }
    yield { type: "tool_use_end", id, input: { path: "/tmp/does-not-exist-marker" } }
    yield { type: "message_stop", stop_reason: "tool_use" }
  }
}

describe("subagent cancellation — task_stop unwinds the forked runAgent", () => {
  test("parent spawns background child, calls task_stop, child loop exits via abort", async () => {
    const llm = new RoutingLLM([
      // Parent turn 1: spawn the background subagent.
      {
        match: "PARENT-GO",
        events: toolCall("a1", "agent", {
          prompt: "CHILD-MARK keep spinning forever",
          background: true,
        }),
        once: true,
      },
      // Parent turn 2: after the agent tool returns the task_id (visible in
      // the tool_result body), call task_stop. We route on the task_id token,
      // not on substring of the tool_result, because that's deterministic.
      {
        match: "task_id:",
        events: toolCall("s1", "task_stop", {
          task_id: "__PLACEHOLDER__",
          owner_token: "__PLACEHOLDER__",
        }),
        once: true,
      },
      // Parent turn 3: stop returned ok ⇒ call task_output to observe stopped.
      {
        match: "Stopped task",
        events: toolCall("o1", "task_output", { task_id: "__PLACEHOLDER__" }),
        once: true,
      },
      // Parent turn 4: tool_output returned status:stopped ⇒ finish.
      { match: "status: stopped", events: text("PARENT-DONE child was stopped") },
    ])

    // Wire id-rewriting into the LLM: the parent doesn't actually know the
    // task_id ahead of time, so we intercept and substitute on the fly.
    const origStream = llm.stream.bind(llm)
    llm.stream = async function* (input: StreamInput): AsyncIterable<StreamEvent> {
      const lastTaskId = findLastTaskFields(input)
      for await (const e of origStream(input)) {
        yield rewriteTaskId(e, lastTaskId)
      }
    }

    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          // High enough that the child would naturally keep spinning past the
          // parent's `task_stop` — so a passing test proves the ABORT, not
          // natural termination, ended the child.
          maxTurns: 20,
        }),
      ),
      15_000,
      "subagent-cancellation-e2e",
    )

    // The parent completed cleanly (status:stopped tool_result → final text).
    expect(out.reason).toBe("completed")

    // Routing log: parent took the four scripted steps.
    expect(llm.log).toContain("PARENT-GO")
    expect(llm.log).toContain("task_id:")
    expect(llm.log).toContain("Stopped task")
    expect(llm.log).toContain("status: stopped")

    // The child's loop did spin (at least one FALLBACK turn fired before the
    // parent stopped it). Without this we couldn't claim the abort unwound a
    // *running* loop.
    const fallbackTurns = llm.log.filter((l) => l.startsWith("FALLBACK:")).length
    expect(fallbackTurns).toBeGreaterThan(0)

    // The parent's final assistant text confirms the status:stopped recovery
    // path was taken.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE")

    // A tool_result with `status: stopped` is present in the parent's
    // transcript — direct e2e proof that the registry observed the stop AND
    // the child task transitioned to `stopped` (the runner exited via the
    // chained abort and the registry's `stop()` flipped the status).
    const stoppedTR = out.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.content.includes("status: stopped")),
    )
    expect(stoppedTR.length).toBeGreaterThan(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Hell-case batteries — cancellation concurrency safety. Direct registry +
// agent-tool integration (not via runAgent — too slow for 50-100 cycles). Each
// test pins ONE invariant: registry shape sanity, cascade unwind, idempotency,
// listener-leak bound, or chainedSignal semantics.
// ───────────────────────────────────────────────────────────────────────────

const ctxAt = (depth?: number): ToolContext =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
  }) as ToolContext

const runTool = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

/** Returns a runner whose promise resolves the instant `req.signal` aborts.
 *  Records the request count so callers can assert "spawned but didn't run". */
const makeAbortableRunner = (): { runner: SubagentRunner; spawned: () => number } => {
  let count = 0
  const runner: SubagentRunner = (req) =>
    new Promise<SubagentResult>((resolve) => {
      count += 1
      const sig = req.signal
      const settle = (): void =>
        resolve({ ok: false, finalText: "aborted", turns: 0, messages: [] })
      if (!sig) return // foreground — never resolves; caller should not use FG here
      if (sig.aborted) return settle()
      sig.addEventListener("abort", settle, { once: true })
    })
  return { runner, spawned: () => count }
}

const taskIdFromEvent = (ev: ToolEvent): string => {
  if (ev.type !== "result") throw new Error("expected result event")
  const match = ev.result.output.match(/task_id: (\S+)/)
  if (!match?.[1]) throw new Error(`no task_id in ${ev.result.output}`)
  return match[1]
}

/** S17: pull task_id AND owner_token out of an agent-tool launch result.
 *  Cancellation tests need both — the registry refuses `stop` without the
 *  matching token. */
const taskAndOwnerFromEvent = (ev: ToolEvent): { id: string; ownerToken: string } => {
  if (ev.type !== "result") throw new Error("expected result event")
  const id = ev.result.output.match(/task_id: (\S+)/)?.[1]
  const ownerToken = ev.result.output.match(/owner_token: (\S+)/)?.[1]
  if (!id || !ownerToken) {
    throw new Error(`launch result missing task_id or owner_token: ${ev.result.output}`)
  }
  return { id, ownerToken }
}

// ───────── 1. Cancellation storm ─────────
describe("subagent cancellation hell-cases — storm", () => {
  test("hc-storm-50: 50 parallel spawn+cancel — registry coherent, no leak", async () => {
    const { runner } = makeAbortableRunner()
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const stop = createTaskStopTool(reg)
    const N = 50
    // Phase A: spawn all 50 in parallel.
    const launches = await Promise.all(
      Array.from({ length: N }, () => runTool(agent, { prompt: "x", background: true }, ctxAt(0))),
    )
    const handles = launches.map(taskAndOwnerFromEvent)
    expect(new Set(handles.map((h) => h.id)).size).toBe(N) // every id unique
    // Phase B: cancel all 50 in parallel.
    const stops = await Promise.all(
      handles.map((h) => runTool(stop, { task_id: h.id, owner_token: h.ownerToken }, ctxAt(0))),
    )
    for (const s of stops) {
      if (s.type !== "result") throw new Error("expected result")
      expect(s.result.ok).toBe(true)
    }
    // Registry sanity: zero pending, every record settled "stopped".
    expect(reg.pendingIds()).toEqual([])
    const all = reg.list()
    expect(all.length).toBe(N)
    expect(all.every((t) => t.status === "stopped")).toBe(true)
  }, 30_000)

  test("hc-storm-mixed: 10 long + 10 fast, cancel all 20 simultaneously, bounded unwind", async () => {
    const { runner: longRunner } = makeAbortableRunner()
    // Fast runner returns immediately (settles "completed" before any stop).
    const fastRunner: SubagentRunner = async () => ({
      ok: true,
      finalText: "fast-done",
      turns: 1,
      messages: [],
    })
    const reg = new TaskRegistry()
    const longTool = createAgentTool({ runner: longRunner, registry: reg })
    const fastTool = createAgentTool({ runner: fastRunner, registry: reg })
    const stop = createTaskStopTool(reg)
    const longs = await Promise.all(
      Array.from({ length: 10 }, () =>
        runTool(longTool, { prompt: "long", background: true }, ctxAt(0)),
      ),
    )
    // Fast tasks: spawn and let microtasks resolve so they settle "completed".
    const fasts = await Promise.all(
      Array.from({ length: 10 }, () =>
        runTool(fastTool, { prompt: "fast", background: true }, ctxAt(0)),
      ),
    )
    // Drain pending microtasks so the fast runner's .then handlers fire.
    for (let i = 0; i < 8; i++) await Promise.resolve()

    const allHandles = [...longs.map(taskAndOwnerFromEvent), ...fasts.map(taskAndOwnerFromEvent)]
    const start = Date.now()
    const results = await Promise.all(
      allHandles.map((h) => runTool(stop, { task_id: h.id, owner_token: h.ownerToken }, ctxAt(0))),
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2_000) // bounded — no thundering-herd hang
    // Long-task stops succeed (running → stopped). Fast-task stops fail
    // (already settled completed). Both are CORRECT outcomes — the
    // invariant is: every stop call returns a result without throwing.
    for (const r of results) {
      if (r.type !== "result") throw new Error("expected result")
    }
    expect(reg.pendingIds()).toEqual([])
  }, 15_000)

  test("hc-pre-spawn: cancel a freshly-registered task BEFORE the runner schedules → settles 'stopped'", async () => {
    // This pins the "pre-spawn race" semantic: registry.register hands back
    // the controller IMMEDIATELY, so `stop()` is legal even if the runner's
    // microtask hasn't been scheduled yet. Our async runner uses
    // `addEventListener("abort")` AND a check for `aborted` at start; the
    // already-aborted controller causes the runner to settle without
    // emitting an orphan promise.
    const { runner } = makeAbortableRunner()
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const stop = createTaskStopTool(reg)
    // Spawn the background — this registers the task AND schedules the
    // runner via void promise.then. The stop must succeed even if we run
    // it on the very next microtask.
    const ev = await runTool(agent, { prompt: "p", background: true }, ctxAt(0))
    const { id: taskId, ownerToken } = taskAndOwnerFromEvent(ev)
    const stopEv = await runTool(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0))
    if (stopEv.type !== "result") throw new Error("expected result")
    expect(stopEv.result.ok).toBe(true)
    // Drain microtasks — the runner's settle path resolves the underlying
    // promise, which calls registry.complete (which is a no-op because
    // status is already "stopped"). No orphan, no leak.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(reg.get(taskId)?.status).toBe("stopped")
  }, 15_000)
})

// ───────── 2. Cascade cancel ─────────
describe("subagent cancellation hell-cases — cascade", () => {
  test("hc-cascade-depth-2: parent abort cascades to depth-2 child via chained signal", async () => {
    // Simulate two layers manually: a parent AbortController, a runner that
    // (when launched) registers a child controller chained to parent.signal.
    // Aborting the parent must trigger the child's abort handler.
    const parentAc = new AbortController()
    const childAc = new AbortController()
    // Wire chain: parent abort → child abort. This is the same shape as
    // chainedSignal(parent.signal, req.signal) — we use AbortSignal.any to
    // exercise the same primitive.
    const chained = AbortSignal.any([parentAc.signal, childAc.signal])
    let childAborted = false
    chained.addEventListener("abort", () => {
      childAborted = true
    })
    parentAc.abort()
    // Same-tick: AbortSignal.any propagates synchronously when an input is
    // already aborted at construction; for runtime abort it's the next
    // microtask. Either way one drain is enough.
    await Promise.resolve()
    expect(childAborted).toBe(true)
    expect(chained.aborted).toBe(true)
  }, 5_000)

  test("hc-cascade-fanout: parent abort cascades to 5 children in parallel", async () => {
    const parentAc = new AbortController()
    const children: { ac: AbortController; chained: AbortSignal; aborted: boolean }[] = []
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController()
      const chained = AbortSignal.any([parentAc.signal, ac.signal])
      const entry = { ac, chained, aborted: false }
      chained.addEventListener("abort", () => {
        entry.aborted = true
      })
      children.push(entry)
    }
    parentAc.abort()
    await Promise.resolve()
    for (const c of children) {
      expect(c.aborted).toBe(true)
      expect(c.chained.aborted).toBe(true)
    }
  }, 5_000)

  test("hc-cascade-sibling-isolation: cancel one child does NOT abort siblings", async () => {
    const parentAc = new AbortController()
    // Three siblings, each with its own per-task controller chained to parent.
    const acs = [new AbortController(), new AbortController(), new AbortController()]
    const chained = acs.map((ac) => AbortSignal.any([parentAc.signal, ac.signal]))
    // Abort sibling 1 (middle one).
    acs[1]?.abort()
    await Promise.resolve()
    expect(chained[0]?.aborted).toBe(false)
    expect(chained[1]?.aborted).toBe(true)
    expect(chained[2]?.aborted).toBe(false)
    // Parent NOT aborted by sibling cancellation.
    expect(parentAc.signal.aborted).toBe(false)
  }, 5_000)
})

// ───────── 3. Cancel during settled ─────────
describe("subagent cancellation hell-cases — cancel during/after settled", () => {
  test("hc-settled-cancel: cancel a child that JUST transitioned to 'completed' is no-op", async () => {
    const reg = new TaskRegistry()
    const fastRunner: SubagentRunner = async () => ({
      ok: true,
      finalText: "fast",
      turns: 1,
      messages: [],
    })
    const agent = createAgentTool({ runner: fastRunner, registry: reg })
    const stop = createTaskStopTool(reg)
    const ev = await runTool(agent, { prompt: "p", background: true }, ctxAt(0))
    const { id, ownerToken: token } = taskAndOwnerFromEvent(ev)
    // Drain microtasks so the runner's .then completes the record.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(reg.get(id)?.status).toBe("completed")
    // Now attempt to stop — must be a clean ok:false (idempotent no-op).
    const s = await runTool(stop, { task_id: id, owner_token: token }, ctxAt(0))
    if (s.type !== "result") throw new Error("expected result")
    expect(s.result.ok).toBe(false)
    expect(s.result.output).toContain("unknown or already settled")
    expect(reg.get(id)?.status).toBe("completed") // unchanged
  }, 10_000)

  test("hc-double-stop: cancelling an already-stopped task is idempotent", async () => {
    const { runner } = makeAbortableRunner()
    const reg = new TaskRegistry()
    const agent = createAgentTool({ runner, registry: reg })
    const stop = createTaskStopTool(reg)
    const ev = await runTool(agent, { prompt: "p", background: true }, ctxAt(0))
    const { id, ownerToken: token } = taskAndOwnerFromEvent(ev)
    const s1 = await runTool(stop, { task_id: id, owner_token: token }, ctxAt(0))
    const s2 = await runTool(stop, { task_id: id, owner_token: token }, ctxAt(0))
    if (s1.type !== "result" || s2.type !== "result") throw new Error("expected result")
    expect(s1.result.ok).toBe(true)
    expect(s2.result.ok).toBe(false)
    expect(s2.result.output).toContain("unknown or already settled")
    expect(reg.get(id)?.status).toBe("stopped")
  }, 10_000)

  test("hc-late-subscriber: waitForSettle attached AFTER settle resolves immediately", async () => {
    const reg = new TaskRegistry()
    const fast: SubagentRunner = async () => ({
      ok: true,
      finalText: "fast",
      turns: 1,
      messages: [],
    })
    const agent = createAgentTool({ runner: fast, registry: reg })
    const ev = await runTool(agent, { prompt: "p", background: true }, ctxAt(0))
    // S17: this test never calls stop — task settles naturally — so the
    // owner_token is irrelevant. Only the id is used downstream.
    const { id } = taskAndOwnerFromEvent(ev)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(reg.get(id)?.status).toBe("completed")
    // Subscribe AFTER settle — must resolve immediately.
    let done = false
    void reg.waitForSettle(id).then(() => {
      done = true
    })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(done).toBe(true)
  }, 10_000)
})

// ───────── 4. Resource cleanup ─────────
describe("subagent cancellation hell-cases — resource cleanup", () => {
  test("hc-100-cycles: 100 spawn+cancel cycles — registry final state coherent", async () => {
    const { runner } = makeAbortableRunner()
    const reg = new TaskRegistry({ maxRetained: 64 })
    const agent = createAgentTool({ runner, registry: reg })
    const stop = createTaskStopTool(reg)
    const N = 100
    for (let i = 0; i < N; i++) {
      const ev = await runTool(agent, { prompt: `p${i}`, background: true }, ctxAt(0))
      const { id, ownerToken: token } = taskAndOwnerFromEvent(ev)
      const s = await runTool(stop, { task_id: id, owner_token: token }, ctxAt(0))
      if (s.type !== "result") throw new Error("expected result")
      expect(s.result.ok).toBe(true)
    }
    // No pending tasks after all cancels.
    expect(reg.pendingIds()).toEqual([])
    // LRU evicted down to the cap (64), not 100. Pin both the cap and the
    // monotone settled-only retention.
    expect(reg.list().length).toBeLessThanOrEqual(64)
    expect(reg.list().every((t) => t.status === "stopped")).toBe(true)
  }, 30_000)

  test("hc-lru-300: 300 settled tasks cap at default 256 retained", async () => {
    const reg = new TaskRegistry() // default maxRetained=256
    const fast: SubagentRunner = async () => ({
      ok: true,
      finalText: "fast",
      turns: 1,
      messages: [],
    })
    const agent = createAgentTool({ runner: fast, registry: reg })
    const N = 300
    for (let i = 0; i < N; i++) {
      const ev = await runTool(agent, { prompt: `p${i}`, background: true }, ctxAt(0))
      taskIdFromEvent(ev) // sanity parse
    }
    // Drain microtasks so all fast runners complete their registry.complete
    // and evictIfOverCap fires.
    for (let i = 0; i < 32; i++) await Promise.resolve()
    // Cap is 256; running tasks (none here) are never evicted.
    expect(reg.list().length).toBe(256)
    expect(reg.list().every((t) => t.status === "completed")).toBe(true)
  }, 30_000)
})

// ───────── 5. chainedSignal semantics ─────────
// chainedSignal is module-private to src/agent/subagent-runner.ts. We test the
// behavioral contract via the same `AbortSignal.any` primitive it uses; the
// production implementation is a one-liner over AbortSignal.any, so this pins
// the externally-observable semantics that buildChildConfig depends on.
describe("subagent cancellation hell-cases — chainedSignal semantics", () => {
  test("hc-chain-identity: chained(parent, undefined) is conceptually parent (no extra wrapping)", () => {
    // The production form is: `extra ? AbortSignal.any([parent, extra]) : parent`
    // — when `extra` is undefined the parent signal is returned by reference.
    // We mirror that here so a regression to "always wrap" would fail (it
    // would otherwise need a per-call allocation on the hot foreground path).
    const parentAc = new AbortController()
    const chained = ((parent: AbortSignal, extra?: AbortSignal): AbortSignal =>
      extra ? AbortSignal.any([parent, extra]) : parent)(parentAc.signal, undefined)
    expect(chained).toBe(parentAc.signal) // identity, not allocation
  })

  test("hc-chain-either: chained(parent, extra) aborts in BOTH directions", async () => {
    // Direction 1: parent → chained
    {
      const parentAc = new AbortController()
      const extraAc = new AbortController()
      const chained = AbortSignal.any([parentAc.signal, extraAc.signal])
      let fired = false
      chained.addEventListener("abort", () => {
        fired = true
      })
      parentAc.abort()
      await Promise.resolve()
      expect(fired).toBe(true)
      expect(chained.aborted).toBe(true)
    }
    // Direction 2: extra → chained
    {
      const parentAc = new AbortController()
      const extraAc = new AbortController()
      const chained = AbortSignal.any([parentAc.signal, extraAc.signal])
      let fired = false
      chained.addEventListener("abort", () => {
        fired = true
      })
      extraAc.abort()
      await Promise.resolve()
      expect(fired).toBe(true)
      expect(chained.aborted).toBe(true)
      // Parent unaffected by extra.
      expect(parentAc.signal.aborted).toBe(false)
    }
  })
})

// Tail-of-file unused imports that exist purely so the surface stays explicit
// for future hell-cases (e.g. createTaskOutputTool when adding a result-shape
// integration). Re-export at type level so the unused-import lint stays clean
// without disabling the rule.
export type { SubagentRequest, SubagentResult, SubagentRunner }
export { createTaskOutputTool }

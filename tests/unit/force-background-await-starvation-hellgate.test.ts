/**
 * force_background — await-on-queued event-loop starvation hellgate (ADR-0487).
 *
 * REAL BUG (this session): `scheduler.await(id)` with no signal loops
 *   `await entry.promise  →  await Promise.resolve()`
 * while the entry is still `queued`. A queued entry's `promise` is the
 * placeholder `Promise.resolve()` that re-settles INSTANTLY, and a microtask
 * yield (`Promise.resolve()`) does NOT drain the MACROTASK queue. So the loop
 * busy-spins microtasks forever and STARVES the event loop: timers / IO — and
 * crucially the runner whose completion frees a slot and the `drainQueue` that
 * would promote this very entry — run on macrotasks that never get a turn. The
 * whole turn hangs (a liveness DoS), and the queued task can never be promoted.
 *
 * Fix: yield a MACROTASK (`setTimeout(resolve, 0)`) while still `queued`, so the
 * event loop makes progress, the slot-freeing runner runs, and the entry is
 * actually promoted → completed.
 *
 * These tests would HANG (or fail) against the pre-fix microtask-yield loop.
 */

import { describe, expect, test } from "bun:test"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"
import type { Tool, ToolContext, ToolResult } from "@/tool"
import { subagentAwaitTool } from "@/tool/subagent-bg/await"

const drain = async <T>(tool: Tool<T>, input: T): Promise<ToolResult> => {
  const ctx = { signal: new AbortController().signal } as unknown as ToolContext
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

const drainWithSignal = async <T>(
  tool: Tool<T>,
  input: T,
  signal: AbortSignal,
): Promise<ToolResult> => {
  const ctx = { signal } as unknown as ToolContext
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

let seq = 0
const idGen = (): string => {
  seq += 1
  return seq.toString(16).padStart(4, "0")
}

const macrotask = (ms = 0): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

describe("force_background — await-on-queued MUST NOT starve the event loop", () => {
  test("HELL-STARVE-1: a macrotask timer still fires while await(queued-forever) is pending", async () => {
    // A runner whose promise NEVER resolves — the one slot is held forever, so
    // the parked entry stays `queued` indefinitely.
    const runner: SubagentRunner = (_req: SubagentRequest) => new Promise<SliceResult>(() => {})
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "holds-the-only-slot" })
    const queuedId = sched.fork({ task: "queued-forever" })

    // Start awaiting the queued entry. With the pre-fix microtask busy-spin this
    // starves all macrotasks and the assertions below could never run.
    let awaitResolved = false
    void sched.await(queuedId).then(() => {
      awaitResolved = true
    })

    // A macrotask timer MUST still fire despite the in-flight await.
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 10)

    // Give the loop ~80ms of real time across several macrotasks.
    await macrotask(80)

    expect(timerFired).toBe(true) // not starved
    expect(awaitResolved).toBe(false) // queued-forever never settles
    // The entry is still queued (its slot never freed) — but the loop is alive.
    expect(sched.poll(queuedId)?.status).toBe("queued")
  })

  test("HELL-STARVE-2: await(queued) RESOLVES once the slot frees → promote → complete", async () => {
    // First run is held until the test frees it; thereafter runs complete.
    let freeFirst: (() => void) | null = null
    let calls = 0
    const runner: SubagentRunner = (_req: SubagentRequest) =>
      new Promise<SliceResult>((res) => {
        calls += 1
        if (calls === 1) {
          freeFirst = () => res({ ok: true, finalText: "first done", turns: 1 })
        } else {
          res({ ok: true, finalText: "queued done", turns: 2 })
        }
      })
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "first" })
    const queuedId = sched.fork({ task: "queued" })
    expect(sched.poll(queuedId)?.status).toBe("queued")

    const awaitP = sched.await(queuedId)
    // Free the slot on a later macrotask — drainQueue must promote `queued`.
    setTimeout(() => freeFirst?.(), 20)

    const result = await awaitP
    expect(result?.status).toBe("completed")
    expect(result?.outputSummary).toBe("queued done")
    expect(result?.turns).toBe(2)
  })

  test("HELL-STARVE-3: concurrent awaits on the SAME queued entry both resolve (no corrupt state)", async () => {
    let freeFirst: (() => void) | null = null
    let calls = 0
    const runner: SubagentRunner = (_req: SubagentRequest) =>
      new Promise<SliceResult>((res) => {
        calls += 1
        if (calls === 1) freeFirst = () => res({ ok: true, finalText: "first", turns: 1 })
        else res({ ok: true, finalText: "q-out", turns: 3 })
      })
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "first" })
    const qId = sched.fork({ task: "q" })

    const a = sched.await(qId)
    const b = sched.await(qId)
    setTimeout(() => freeFirst?.(), 15)

    const [ra, rb] = await Promise.all([a, b])
    expect(ra?.status).toBe("completed")
    expect(rb?.status).toBe("completed")
    expect(ra?.outputSummary).toBe("q-out")
    expect(rb?.outputSummary).toBe("q-out")
  })
})

describe("subagent_await — a QUEUED handle is NON-terminal (must BLOCK, not short-circuit)", () => {
  test("HELL-AWAIT-Q1: await tool on a queued handle BLOCKS until promoted → completed", async () => {
    // REAL BUG: the tool's fast-path treated `status !== 'running'` as terminal,
    // AND the scheduler's signal-path resolved on the queued placeholder promise.
    // Either bug returns the queued snapshot INSTANTLY instead of the answer.
    let freeFirst: (() => void) | null = null
    let calls = 0
    const runner: SubagentRunner = (_req: SubagentRequest) =>
      new Promise<SliceResult>((res) => {
        calls += 1
        if (calls === 1) freeFirst = () => res({ ok: true, finalText: "first", turns: 1 })
        else res({ ok: true, finalText: "the-queued-answer", turns: 4 })
      })
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "first" })
    const qId = sched.fork({ task: "queued" })
    expect(sched.poll(qId)?.status).toBe("queued")

    const tool = subagentAwaitTool(sched)
    const p = drain(tool, { id: qId })
    setTimeout(() => freeFirst?.(), 20)
    const res = await p
    expect(res.ok).toBe(true)
    // MUST be the eventual terminal answer, NOT the instant queued snapshot.
    expect(res.output).toContain("status=completed")
    expect(res.output).toContain("the-queued-answer")
    expect(res.output).not.toContain("status=queued")
  })

  test("HELL-AWAIT-Q2: timeout on a queued-forever handle returns status=queued (no hang)", async () => {
    const runner: SubagentRunner = (_req: SubagentRequest) => new Promise<SliceResult>(() => {})
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "holds-slot" })
    const qId = sched.fork({ task: "queued-forever" })
    const tool = subagentAwaitTool(sched)
    const res = await drain(tool, { id: qId, timeoutMs: 30 })
    // Times out → surfaces the still-queued snapshot so the caller can poll again.
    expect(res.ok).toBe(true)
    expect(res.output).toContain("status=queued")
  })

  test("HELL-AWAIT-Q3: ctx-abort on a queued handle unblocks with the current snapshot", async () => {
    const runner: SubagentRunner = (_req: SubagentRequest) => new Promise<SliceResult>(() => {})
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "holds-slot" })
    const qId = sched.fork({ task: "queued" })
    const tool = subagentAwaitTool(sched)
    const ac = new AbortController()
    const p = drainWithSignal(tool, { id: qId }, ac.signal)
    setTimeout(() => ac.abort(), 20)
    const res = await p
    // Aborted-while-waiting returns the current snapshot (still queued); never hangs.
    expect(res.ok).toBe(true)
    expect(res.output).toContain("status=queued")
  })
})

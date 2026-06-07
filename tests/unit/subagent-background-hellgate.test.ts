/**
 * BackgroundSubagentScheduler + 3 tools — hellgate (ADR-0130).
 *
 * 20+ adversarial cases sealing the scheduler core, runner integration, and
 * tool surface. All in-memory; the injected runner is a controllable fake.
 */

import { describe, expect, test } from "bun:test"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
  SubagentBackgroundError,
  type SubagentResult,
} from "@/agent/subagent-background"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import {
  type BackgroundSubagentSchedulerPort,
  subagentAwaitTool,
  subagentBgTools,
  subagentForkTool,
  subagentPollTool,
} from "@/tool/subagent-bg"

/** Drive a tool's async generator to its terminal result. */
const drive = async <I>(
  tool: { execute: (input: I, ctx: ToolContext) => AsyncIterable<ToolEvent> },
  input: I,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no terminal result")
  return last
}

const baseCtx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  signal: signal ?? new AbortController().signal,
})

/** A runner whose completion is controlled by an external deferred. The
 *  factory returns `{runner, resolve, reject, captured}` — `captured` is the
 *  request the runner observed (asserted in tests). */
const controlledRunner = (): {
  runner: SubagentRunner
  resolve: (out: SliceResult) => void
  reject: (e: Error) => void
  captured: { req: SubagentRequest | null }
  abortObserved: () => boolean
} => {
  let resolveFn: ((out: SliceResult) => void) | null = null
  let rejectFn: ((e: Error) => void) | null = null
  let abortFired = false
  const captured: { req: SubagentRequest | null } = { req: null }
  const runner: SubagentRunner = (req) => {
    captured.req = req
    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        abortFired = true
      })
    }
    return new Promise<SliceResult>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
  }
  return {
    runner,
    resolve: (out) => {
      if (resolveFn) resolveFn(out)
    },
    reject: (e) => {
      if (rejectFn) rejectFn(e)
    },
    captured,
    abortObserved: () => abortFired,
  }
}

/** Drain microtasks so a synchronous resolve propagates through pending awaits. */
const yieldMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// ─────────────────────────────────────────────────────────────
// A. Scheduler core (10)
// ─────────────────────────────────────────────────────────────

describe("BackgroundSubagentScheduler — A. core", () => {
  test("HELL-1: fork returns id; poll reports running", () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "ping" })
    expect(id).toMatch(/^bg-[0-9a-f]+$/)
    const snap = sched.poll(id)
    expect(snap).not.toBeNull()
    expect(snap?.status).toBe("running")
    expect(snap?.outputSummary).toContain("running")
    expect(snap?.turns).toBe(0)
  })

  test("HELL-2: fork cap-exceeded throws typed SubagentBackgroundError", () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 2 })
    sched.fork({ task: "a" })
    sched.fork({ task: "b" })
    let caught: unknown = null
    try {
      sched.fork({ task: "c" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SubagentBackgroundError)
    expect((caught as SubagentBackgroundError).code).toBe("cap-exceeded")
  })

  test("HELL-3: poll unknown id returns null", () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    expect(sched.poll("bg-nonsense")).toBeNull()
  })

  test("HELL-4: await unknown id resolves to null", async () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const out = await sched.await("bg-missing")
    expect(out).toBeNull()
  })

  test("HELL-5: await running resolves after runner settles", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "compute" })
    const p = sched.await(id)
    // Resolve the runner asynchronously to ensure await actually waits.
    setTimeout(() => resolve({ ok: true, finalText: "result-text", turns: 4 }), 0)
    const out = await p
    expect(out?.status).toBe("completed")
    expect(out?.outputDetail).toBe("result-text")
    expect(out?.turns).toBe(4)
    expect(out?.endedAt).toBeGreaterThanOrEqual(out?.startedAt ?? 0)
  })

  test("HELL-6: await with aborted signal returns current snapshot (no cancel)", async () => {
    const { runner, resolve, abortObserved } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "slow" })
    const ctrl = new AbortController()
    const awaitP = sched.await(id, { signal: ctrl.signal })
    ctrl.abort()
    const snap = await awaitP
    expect(snap?.status).toBe("running")
    // The await-side controller IS aborted — observable on its signal.
    expect(ctrl.signal.aborted).toBe(true)
    // Subagent's own signal MUST NOT have fired — await-signal abort != cancel.
    expect(abortObserved()).toBe(false)
    // Cleanup: resolve the runner to avoid leaking the promise.
    resolve({ ok: true, finalText: "x", turns: 1 })
    await yieldMicrotasks()
  })

  test("HELL-7: cancel running flips status to cancelled; await resolves", async () => {
    const { runner, abortObserved, resolve, captured } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "x" })
    const awaitP = sched.await(id)
    const ok = sched.cancel(id)
    expect(ok).toBe(true)
    // Subagent's signal MUST have been aborted.
    expect(abortObserved()).toBe(true)
    // The runner's request-signal IS now aborted — verifying the abort
    // propagated to the actual signal handed to the child, not just our
    // listener bookkeeping.
    expect(captured.req?.signal?.aborted).toBe(true)
    // Resolve the runner (the abort doesn't auto-reject in our fake).
    resolve({ ok: true, finalText: "(ignored — already cancelled)", turns: 0 })
    const snap = await awaitP
    expect(snap?.status).toBe("cancelled")
    expect(snap?.endedAt).toBeDefined()
  })

  test("HELL-8: stop call against unknown id returns false (no-op contract, no signal touched)", () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    expect(sched.cancel("bg-ghost")).toBe(false)
  })

  test("HELL-9: list returns all entries (running + completed)", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id1 = sched.fork({ task: "a" })
    const id2 = sched.fork({ task: "b" })
    const list1 = sched.list()
    expect(list1).toHaveLength(2)
    // Newest first
    expect(list1[0]?.id).toBe(id2)
    expect(list1[1]?.id).toBe(id1)
    // Statuses both running
    expect(list1.every((e) => e.result.status === "running")).toBe(true)
    // Move id1 to completed by resolving the runner (single shared resolveFn
    // points at whichever was the LAST fork — that's id2 in our fake).
    // To make this assertion deterministic across both, run cancel on id1
    // (terminal transition).
    sched.cancel(id1)
    resolve({ ok: true, finalText: "done", turns: 1 })
    await yieldMicrotasks()
    const list2 = sched.list()
    expect(list2).toHaveLength(2)
    const statuses = new Set(list2.map((e) => e.result.status))
    expect(statuses.has("cancelled")).toBe(true)
    expect(statuses.has("completed")).toBe(true)
  })

  test("HELL-10: prune drops only terminal entries older than threshold", async () => {
    let nowMs = 1_000
    const now = (): number => nowMs
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, now })
    const id = sched.fork({ task: "x" })
    resolve({ ok: true, finalText: "ok", turns: 1 })
    await yieldMicrotasks()
    // endedAt = 1000 (now didn't tick). Advance.
    nowMs = 10_000
    // Prune with threshold 1000ms: anything ended before 9000 drops. id's
    // endedAt == 1000 which is < 9000 → drop.
    const dropped = sched.prune(1_000)
    expect(dropped).toBe(1)
    expect(sched.poll(id)).toBeNull()
    // Now fork another and DON'T resolve — running entries are never pruned.
    const { runner: r2 } = controlledRunner()
    const sched2 = defaultBackgroundSubagentScheduler({ runner: r2, now })
    const id2 = sched2.fork({ task: "long" })
    nowMs = 1_000_000
    expect(sched2.prune(1)).toBe(0)
    expect(sched2.poll(id2)?.status).toBe("running")
  })
})

// ─────────────────────────────────────────────────────────────
// B. Runner integration (4)
// ─────────────────────────────────────────────────────────────

describe("BackgroundSubagentScheduler — B. runner integration", () => {
  test("HELL-11: runner resolves ok=true → completed + outputDetail set", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "compute" })
    resolve({ ok: true, finalText: "the answer is 42", turns: 3 })
    const snap = await sched.await(id)
    expect(snap?.status).toBe("completed")
    expect(snap?.outputDetail).toBe("the answer is 42")
    expect(snap?.turns).toBe(3)
  })

  test("HELL-12: runner rejects → failed + errorMessage set", async () => {
    const { runner, reject } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "boom" })
    reject(new Error("transport collapsed"))
    const snap = await sched.await(id)
    expect(snap?.status).toBe("failed")
    expect(snap?.errorMessage).toContain("transport collapsed")
    expect(snap?.outputSummary).toContain("failed")
  })

  test("HELL-13: runner respects abort signal → cancelled on cancel()", async () => {
    const { runner, reject } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "abort-me" })
    const awaitP = sched.await(id)
    sched.cancel(id)
    // Simulate a well-behaved runner that propagates abort as a rejection.
    reject(new Error("AbortError: aborted"))
    const snap = await awaitP
    expect(snap?.status).toBe("cancelled")
  })

  test("HELL-14: multiple concurrent forks run concurrently", async () => {
    // Use a runner factory so each fork gets its own controllable promise.
    type Slot = {
      resolve: (out: SliceResult) => void
    }
    const slots: Slot[] = []
    const runner: SubagentRunner = () =>
      new Promise<SliceResult>((res) => {
        slots.push({ resolve: res })
      })
    const sched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 5 })
    const ids = [sched.fork({ task: "a" }), sched.fork({ task: "b" }), sched.fork({ task: "c" })]
    // All 3 should be running BEFORE any resolves.
    expect(ids.every((i) => sched.poll(i)?.status === "running")).toBe(true)
    expect(slots).toHaveLength(3)
    // Resolve out of order to prove independence.
    slots[1]?.resolve({ ok: true, finalText: "b-done", turns: 1 })
    slots[0]?.resolve({ ok: true, finalText: "a-done", turns: 2 })
    slots[2]?.resolve({ ok: true, finalText: "c-done", turns: 3 })
    await yieldMicrotasks()
    expect(sched.poll(ids[0] ?? "")?.outputDetail).toBe("a-done")
    expect(sched.poll(ids[1] ?? "")?.outputDetail).toBe("b-done")
    expect(sched.poll(ids[2] ?? "")?.outputDetail).toBe("c-done")
  })
})

// ─────────────────────────────────────────────────────────────
// C. Tools (6)
// ─────────────────────────────────────────────────────────────

describe("background subagent tools — C. tool surface", () => {
  test("HELL-15: subagent_fork happy → ok:true with bg- id", async () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const tool = subagentForkTool(sched)
    const res = await drive(tool, { task: "hello" }, baseCtx())
    expect(res.ok).toBe(true)
    expect(res.output).toMatch(/forked id=bg-[0-9a-f]+/)
  })

  test("HELL-16: subagent_fork at cap → ok:false cap-exceeded", async () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 1 })
    const tool = subagentForkTool(sched)
    const first = await drive(tool, { task: "first" }, baseCtx())
    expect(first.ok).toBe(true)
    const second = await drive(tool, { task: "second" }, baseCtx())
    expect(second.ok).toBe(false)
    expect(second.output).toContain("cap-exceeded")
  })

  test("HELL-17: subagent_poll happy → ok:true with status line", async () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "x" })
    const tool = subagentPollTool(sched)
    const res = await drive(tool, { id }, baseCtx())
    expect(res.ok).toBe(true)
    expect(res.output).toContain("status=running")
    expect(res.output).toContain(id)
  })

  test("HELL-18: subagent_poll unknown id → ok:false unknown-handle", async () => {
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const tool = subagentPollTool(sched)
    const res = await drive(tool, { id: "bg-ghost" }, baseCtx())
    expect(res.ok).toBe(false)
    expect(res.output).toContain("unknown-handle")
  })

  test("HELL-19: subagent_await timeout → ok:true status=running", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "slow" })
    const tool = subagentAwaitTool(sched)
    const res = await drive(tool, { id, timeoutMs: 25 }, baseCtx())
    expect(res.ok).toBe(true)
    expect(res.output).toContain("status=running")
    // Cleanup
    resolve({ ok: true, finalText: "done", turns: 1 })
    await yieldMicrotasks()
  })

  test("HELL-20: subagent_await happy → ok:true with completed status + detail", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "quick" })
    const tool = subagentAwaitTool(sched)
    // Resolve before drive so the fast-path triggers terminal status.
    resolve({ ok: true, finalText: "quick result body", turns: 2 })
    await yieldMicrotasks()
    const res = await drive(tool, { id }, baseCtx())
    expect(res.ok).toBe(true)
    expect(res.output).toContain("status=completed")
    expect(res.output).toContain("quick result body")
    expect(res.output).toContain("turns=2")
  })

  test("HELL-20b: subagent tool port stays fork/poll/await-only", () => {
    const minimalPort: BackgroundSubagentSchedulerPort = {
      fork: () => "bg-minimal",
      poll: () => null,
      await: async () => null,
      forceBackground: () => "not_found",
    }
    expect(subagentBgTools(minimalPort).map((tool) => tool.name)).toEqual([
      "subagent_fork",
      "subagent_poll",
      "subagent_await",
    ])
  })
})

// ─────────────────────────────────────────────────────────────
// D. Invariants (extra)
// ─────────────────────────────────────────────────────────────

describe("BackgroundSubagentScheduler — D. invariants", () => {
  test("HELL-21: snapshot is frozen-shape (no undefined optional fields)", () => {
    const { runner } = controlledRunner()
    const sched: BackgroundSubagentScheduler = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "x" })
    const snap = sched.poll(id) as SubagentResult
    // Running snapshot — endedAt / outputDetail / errorMessage absent.
    expect("endedAt" in snap).toBe(false)
    expect("outputDetail" in snap).toBe(false)
    expect("errorMessage" in snap).toBe(false)
    // Required fields present.
    expect(snap.status).toBe("running")
    expect(typeof snap.startedAt).toBe("number")
    expect(snap.turns).toBe(0)
  })

  test("HELL-22: idGen + now injection are honored", () => {
    let counter = 0
    let nowMs = 5_000
    const { runner } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      now: () => nowMs,
      idGen: () => `fake${++counter}`,
    })
    const id1 = sched.fork({ task: "a" })
    expect(id1).toBe("bg-fake1")
    expect(sched.poll(id1)?.startedAt).toBe(5_000)
    nowMs = 9_000
    const id2 = sched.fork({ task: "b" })
    expect(id2).toBe("bg-fake2")
    expect(sched.poll(id2)?.startedAt).toBe(9_000)
  })

  test("HELL-23: stop on a completed task is idempotent (returns true; no status flip)", async () => {
    const { runner, resolve } = controlledRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    const id = sched.fork({ task: "x" })
    resolve({ ok: true, finalText: "done", turns: 1 })
    await sched.await(id)
    expect(sched.poll(id)?.status).toBe("completed")
    const ok = sched.cancel(id)
    expect(ok).toBe(true)
    expect(sched.poll(id)?.status).toBe("completed")
  })
})

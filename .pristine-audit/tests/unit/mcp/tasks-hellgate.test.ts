/** ADR-0196 — MCP tasks port + store hellgate.
 *
 *  Sections (10 cases):
 *    HELL-T-01: list paginates; stale cursor → typed `cursor-stale`
 *    HELL-T-02: cancel after completed → typed `not-cancellable`
 *    HELL-T-03: poller AbortSignal clean shutdown
 *    HELL-T-04: getResult before completion → `not-ready`
 *    HELL-T-05: store full-cap FIFO eviction
 *    HELL-T-06..10: 5 state round-trips */

import { describe, expect, test } from "bun:test"
import {
  DefaultTaskStore,
  defaultTasksPort,
  type McpTaskInfo,
  pollTask,
  type TaskState,
  TERMINAL_TASK_STATES,
} from "@/mcp"

const mk = (id: string, state: TaskState, extras: Partial<McpTaskInfo> = {}): McpTaskInfo => ({
  taskId: id,
  state,
  ...extras,
})

describe("McpTasksPort + DefaultTaskStore (HELL-T)", () => {
  test("HELL-T-01: list paginates with cursor; stale cursor → typed cursor-stale", async () => {
    const store = new DefaultTaskStore()
    for (let i = 0; i < 75; i++) store.upsert(mk(`t${i}`, "pending"))
    const port = defaultTasksPort(store)

    const first = await port.list()
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("unreachable")
    expect(first.page.tasks.length).toBe(50)
    expect(first.page.nextCursor).toBe("50")

    const second = await port.list(first.page.nextCursor)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("unreachable")
    expect(second.page.tasks.length).toBe(25)
    expect(second.page.nextCursor).toBeUndefined()

    // Stale cursor (way past end) → typed failure, NEVER throws.
    const stale = await port.list("9999")
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error("unreachable")
    expect(stale.failure.reason).toBe("cursor-stale")
  })

  test("HELL-T-02: cancel after completed → typed not-cancellable", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("done", "completed"), { state: "completed", output: "" })
    const port = defaultTasksPort(store)

    const result = await port.cancel("done")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("not-cancellable")
  })

  test("HELL-T-02b: cancel idempotent on terminal cancelled", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("c", "in_progress"))
    const port = defaultTasksPort(store)
    expect((await port.cancel("c")).ok).toBe(true)
    // Second cancel is a no-op idempotent OK.
    expect((await port.cancel("c")).ok).toBe(true)
  })

  test("HELL-T-03: poller AbortSignal clean shutdown — no subscription leak", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("never", "in_progress"))
    const port = defaultTasksPort(store)

    const ac = new AbortController()
    const pending = pollTask(port, "never", { signal: ac.signal, intervalMs: 10 })
    // Abort immediately — the poller must resolve to null without throwing.
    queueMicrotask(() => ac.abort())
    const result = await pending
    expect(result).toBeNull()
  })

  test("HELL-T-04: getResult before completion → not-ready", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("p", "pending"))
    store.upsert(mk("i", "in_progress"))
    const port = defaultTasksPort(store)
    expect((await port.getResult("p")).state).toBe("not-ready")
    expect((await port.getResult("i")).state).toBe("not-ready")
    expect((await port.getResult("unknown-id")).state).toBe("not-ready")
  })

  test("HELL-T-05: store full-cap FIFO eviction", () => {
    const store = new DefaultTaskStore()
    // Insert 256+1 entries; the oldest (first) must be dropped.
    for (let i = 0; i < 257; i++) store.upsert(mk(`x${i}`, "pending"))
    expect(store.size()).toBe(256)
    expect(store.get("x0")).toBeUndefined() // FIFO: oldest evicted
    expect(store.get("x1")).toBeDefined()
    expect(store.get("x256")).toBeDefined()
  })

  test("HELL-T-06: pending round-trip", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("p", "pending"))
    const port = defaultTasksPort(store)
    const info = await port.getInfo("p")
    expect(info?.state).toBe("pending")
  })

  test("HELL-T-07: in_progress round-trip + state transition", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("w", "pending"))
    store.upsert(mk("w", "in_progress"))
    const port = defaultTasksPort(store)
    expect((await port.getInfo("w"))?.state).toBe("in_progress")
  })

  test("HELL-T-08: completed round-trip carries output", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("ok", "completed"), { state: "completed", output: "42" })
    const port = defaultTasksPort(store)
    const res = await port.getResult("ok")
    expect(res.state).toBe("completed")
    if (res.state !== "completed") throw new Error("unreachable")
    expect(res.output).toBe("42")
  })

  test("HELL-T-09: failed round-trip carries error", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("oops", "failed"), { state: "failed", error: "boom" })
    const port = defaultTasksPort(store)
    const res = await port.getResult("oops")
    expect(res.state).toBe("failed")
    if (res.state !== "failed") throw new Error("unreachable")
    expect(res.error).toBe("boom")
  })

  test("HELL-T-10: cancelled round-trip", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("c", "in_progress"))
    const port = defaultTasksPort(store)
    await port.cancel("c")
    expect((await port.getInfo("c"))?.state).toBe("cancelled")
    expect((await port.getResult("c")).state).toBe("cancelled")
  })

  test("TERMINAL_TASK_STATES anchor matches union (3 arms)", () => {
    expect(TERMINAL_TASK_STATES).toEqual(["completed", "failed", "cancelled"])
  })

  test("HELL-T-poller: returns null when task id unknown", async () => {
    const store = new DefaultTaskStore()
    const port = defaultTasksPort(store)
    const ac = new AbortController()
    const res = await pollTask(port, "no-such-id", { signal: ac.signal, intervalMs: 5 })
    expect(res).toBeNull()
  })

  test("HELL-T-poller: returns terminal info when reached", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("t", "in_progress"))
    const port = defaultTasksPort(store)
    const ac = new AbortController()
    // Flip to completed after a microtask.
    queueMicrotask(() => store.upsert(mk("t", "completed"), { state: "completed", output: "done" }))
    const res = await pollTask(port, "t", { signal: ac.signal, intervalMs: 5 })
    expect(res?.state).toBe("completed")
  })

  // === TICKET-21: server-driven cadence + TTL (injected clock, recorded wait) ==
  // No real timers, no wall-clock thresholds: `now` is injected and `wait` is
  // recorded so the cadence/TTL assertions are exact, not timing-flaky.

  test("HELL-T-cadence: server-advertised pollIntervalMs overrides the default", async () => {
    // The task carries pollIntervalMs:50 → the poller must sleep 50, not the
    // 200ms default, and not the opts.intervalMs fallback.
    const store = new DefaultTaskStore()
    store.upsert(mk("c", "in_progress", { pollIntervalMs: 50 }))
    const port = defaultTasksPort(store)
    const slept: number[] = []
    const ac = new AbortController()
    // Terminalize after the first sleep is recorded so the loop exits.
    const pending = pollTask(port, "c", {
      signal: ac.signal,
      intervalMs: 200,
      wait: async (ms) => {
        slept.push(ms)
        store.upsert(mk("c", "completed"), { state: "completed", output: "ok" })
      },
    })
    const res = await pending
    expect(res?.state).toBe("completed")
    expect(slept).toEqual([50])
  })

  test("HELL-T-cadence-floor: pollIntervalMs:0 is clamped to the floor (no busy-spin)", async () => {
    // A hostile/buggy server advertising 0 must NOT make the poller busy-spin.
    const store = new DefaultTaskStore()
    store.upsert(mk("z", "in_progress", { pollIntervalMs: 0 }))
    const port = defaultTasksPort(store)
    const slept: number[] = []
    const ac = new AbortController()
    await pollTask(port, "z", {
      signal: ac.signal,
      wait: async (ms) => {
        slept.push(ms)
        store.upsert(mk("z", "completed"), { state: "completed", output: "ok" })
      },
    })
    expect(slept.length).toBe(1)
    expect(slept[0]).toBeGreaterThanOrEqual(1) // floored, never 0
  })

  test("HELL-T-cadence-ceiling: an absurd pollIntervalMs is clamped to the ceiling", async () => {
    // A server that stalls the model for hours is clamped to a documented upper
    // bound (robustness, not a tuning heuristic).
    const store = new DefaultTaskStore()
    store.upsert(mk("hi", "in_progress", { pollIntervalMs: 60 * 60 * 1000 }))
    const port = defaultTasksPort(store)
    const slept: number[] = []
    const ac = new AbortController()
    await pollTask(port, "hi", {
      signal: ac.signal,
      wait: async (ms) => {
        slept.push(ms)
        store.upsert(mk("hi", "completed"), { state: "completed", output: "ok" })
      },
    })
    expect(slept.length).toBe(1)
    expect(slept[0]).toBeLessThan(60 * 60 * 1000) // clamped below the absurd value
  })

  test("HELL-T-ttl: ttlMs expiry returns the LAST observed (non-terminal) info, not null", async () => {
    // A never-terminal task with ttlMs:500. With an injected clock that jumps
    // past 500, the poller returns the last observed info (so the model can see
    // the final state + related ids) — distinguishable from abort (null).
    const store = new DefaultTaskStore()
    store.upsert(mk("ttl", "in_progress", { ttlMs: 500, relatedTaskIds: ["sib"] }))
    const port = defaultTasksPort(store)
    let t = 0
    const ac = new AbortController()
    const res = await pollTask(port, "ttl", {
      signal: ac.signal,
      now: () => t,
      // Each wait advances the clock past the TTL window.
      wait: async () => {
        t += 600
      },
    })
    expect(res).not.toBeNull()
    expect(res?.state).toBe("in_progress") // last observed, NOT a terminal flip
    expect(res?.relatedTaskIds).toEqual(["sib"])
  })

  test("HELL-T-ttl-absent: no ttlMs ⇒ never expires (byte-identical to legacy poll)", async () => {
    // Absent TTL must NOT introduce an expiry path: the loop runs to terminal.
    const store = new DefaultTaskStore()
    store.upsert(mk("n", "in_progress"))
    const port = defaultTasksPort(store)
    let t = 0
    const ac = new AbortController()
    const res = await pollTask(port, "n", {
      signal: ac.signal,
      now: () => t,
      wait: async () => {
        t += 10_000_000 // huge clock jump must not matter without ttlMs
        store.upsert(mk("n", "completed"), { state: "completed", output: "done" })
      },
    })
    expect(res?.state).toBe("completed")
  })

  test("HELL-T-related: relatedTaskIds round-trips through getInfo verbatim", async () => {
    const store = new DefaultTaskStore()
    store.upsert(mk("r", "in_progress", { relatedTaskIds: ["a", "b"] }))
    const port = defaultTasksPort(store)
    const info = await port.getInfo("r")
    expect(info).toEqual({ taskId: "r", state: "in_progress", relatedTaskIds: ["a", "b"] })
  })
})

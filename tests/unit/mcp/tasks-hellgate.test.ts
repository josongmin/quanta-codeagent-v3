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
})

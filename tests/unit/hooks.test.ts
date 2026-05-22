import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent"
import { StructuredLogger } from "@/observability"

describe("HookBus", () => {
  test("handlers run sequentially in registration order", async () => {
    const bus = new HookBus()
    const order: number[] = []
    bus.on("turn_start", () => {
      order.push(1)
    })
    bus.on("turn_start", async () => {
      await Promise.resolve()
      order.push(2)
    })
    bus.on("turn_start", () => {
      order.push(3)
    })
    await bus.emit({ type: "turn_start", turn: 1 })
    expect(order).toEqual([1, 2, 3])
  })

  test("async handler is awaited before the next runs", async () => {
    const bus = new HookBus()
    const order: string[] = []
    bus.on("session_start", async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push("slow")
    })
    bus.on("session_start", () => {
      order.push("fast")
    })
    await bus.emit({ type: "session_start", sessionId: "s1" })
    expect(order).toEqual(["slow", "fast"])
  })

  test("a throwing handler is isolated and logged, later handlers still run", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let reached = false
    bus.on("post_tool_use", () => {
      throw new Error("boom")
    })
    bus.on("post_tool_use", () => {
      reached = true
    })
    const result = await bus.emit({ type: "post_tool_use", name: "read", ok: true, output: "x" })
    expect(result.deny).toBeNull()
    expect(reached).toBe(true)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0] ?? "{}") as { event: string; fields: { error: string } }
    expect(rec.event).toBe("hook.handler.error")
    expect(rec.fields.error).toBe("boom")
  })

  test("pre_tool_use handler may return { deny }, first deny wins", async () => {
    const bus = new HookBus()
    let secondRan = false
    bus.on("pre_tool_use", () => ({ deny: "nope" }))
    bus.on("pre_tool_use", () => {
      secondRan = true
      return { deny: "later" }
    })
    const result = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(result.deny).toEqual({ deny: "nope" })
    // later handlers still run (isolation), but the first deny is what's returned
    expect(secondRan).toBe(true)
  })

  test("deny only honored for pre_tool_use", async () => {
    const bus = new HookBus()
    // a non-pre_tool_use handler returning a deny-shaped value is ignored
    bus.on("turn_start", () => ({ deny: "ignored" }) as unknown as undefined)
    const result = await bus.emit({ type: "turn_start", turn: 2 })
    expect(result.deny).toBeNull()
  })

  test("emit with no handlers returns { deny: null } (zero overhead path)", async () => {
    const bus = new HookBus()
    const result = await bus.emit({ type: "session_end", reason: "completed", turns: 3 })
    expect(result.deny).toBeNull()
  })
})

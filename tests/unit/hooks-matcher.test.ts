import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent"
import { StructuredLogger } from "@/observability"

describe("HookBus matcher (Tier-0 #0-1 AWF 2-matcher)", () => {
  test("no matcher fires for any tool name (legacy 2-arg parity)", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on("pre_tool_use", (e) => {
      seen.push(e.name)
    })
    await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "task", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "anything_else", input: {} })
    expect(seen).toEqual(["read", "task", "anything_else"])
  })

  test("string matcher fires only on exact match", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on(
      "pre_tool_use",
      (e) => {
        seen.push(e.name)
      },
      { matcher: "write" },
    )
    await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "write-but-different", input: {} })
    expect(seen).toEqual(["write"])
  })

  test("string[] matcher fires when name is in list", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on(
      "pre_tool_use",
      (e) => {
        seen.push(e.name)
      },
      { matcher: ["read", "write", "edit"] },
    )
    await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "task", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "edit", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "grep", input: {} })
    expect(seen).toEqual(["read", "edit"])
  })

  test("RegExp matcher fires when pattern matches", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on(
      "pre_tool_use",
      (e) => {
        seen.push(e.name)
      },
      { matcher: /^task/ },
    )
    await bus.emit({ type: "pre_tool_use", name: "task", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "task_output", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    expect(seen).toEqual(["task", "task_output"])
  })

  test("function matcher fires when fn returns truthy", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on(
      "pre_tool_use",
      (e) => {
        seen.push(e.name)
      },
      { matcher: (n) => n.length > 4 },
    )
    await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    await bus.emit({ type: "pre_tool_use", name: "task_output", input: {} })
    expect(seen).toEqual(["write", "task_output"])
  })

  test("two handlers with different matchers: each fires only for its match; first-deny-wins preserved", async () => {
    const bus = new HookBus()
    const fsSeen: string[] = []
    const agentSeen: string[] = []
    bus.on(
      "pre_tool_use",
      (e) => {
        fsSeen.push(e.name)
        return { deny: `fs blocked ${e.name}` }
      },
      { matcher: ["read", "write", "edit"] },
    )
    bus.on(
      "pre_tool_use",
      (e) => {
        agentSeen.push(e.name)
        return { deny: `agent blocked ${e.name}` }
      },
      { matcher: ["task", "task_output"] },
    )

    const fsDeny = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(fsDeny).toEqual({ deny: "fs blocked write" })
    expect(fsSeen).toEqual(["write"])
    expect(agentSeen).toEqual([])

    const agentDeny = await bus.emit({ type: "pre_tool_use", name: "task", input: {} })
    expect(agentDeny).toEqual({ deny: "agent blocked task" })
    expect(fsSeen).toEqual(["write"])
    expect(agentSeen).toEqual(["task"])

    const passThrough = await bus.emit({ type: "pre_tool_use", name: "bash", input: {} })
    expect(passThrough).toBeNull()
    expect(fsSeen).toEqual(["write"])
    expect(agentSeen).toEqual(["task"])
  })

  test("first-deny-wins preserved when both matchers cover same name", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ deny: "first" }), { matcher: ["read"] })
    bus.on("pre_tool_use", () => ({ deny: "second" }), { matcher: /^read/ })
    const result = await bus.emit({ type: "pre_tool_use", name: "read", input: {} })
    expect(result).toEqual({ deny: "first" })
  })

  test("matcher is ignored on non-tool events (session_start handler with matcher still fires)", async () => {
    const bus = new HookBus()
    let fired = false
    // matcher would reject every conceivable tool name; non-tool events have no
    // name field, so the matcher MUST be bypassed for session_start.
    bus.on(
      "session_start",
      () => {
        fired = true
      },
      { matcher: () => false },
    )
    await bus.emit({ type: "session_start", sessionId: "s1" })
    expect(fired).toBe(true)
  })

  test("matcher coexists with throw-isolation: throwing handler does not break matched sibling", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let siblingRan = false
    bus.on(
      "pre_tool_use",
      () => {
        throw new Error("boom")
      },
      { matcher: ["write"] },
    )
    bus.on(
      "pre_tool_use",
      () => {
        siblingRan = true
      },
      { matcher: ["write"] },
    )
    const deny = await bus.emit({ type: "pre_tool_use", name: "write", input: {} })
    expect(deny).toBeNull()
    expect(siblingRan).toBe(true)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0] ?? "{}") as { event: string; fields: { error: string } }
    expect(rec.event).toBe("hook.handler.error")
    expect(rec.fields.error).toBe("boom")
  })
})

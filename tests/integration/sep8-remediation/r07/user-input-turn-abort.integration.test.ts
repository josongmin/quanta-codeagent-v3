import { describe, expect, test } from "bun:test"
import { createWebUserInputPort } from "@/apps/web-daemon/web-user-input-port"

describe("G-F12 live port: socket stays, turn abort settles", () => {
  test("pending 0 after abort; sibling turn on same handle survives", async () => {
    const captured: string[] = []
    const h = createWebUserInputPort({
      capture: (ev) => captured.push(ev.type),
    })
    const ac = new AbortController()
    const aborted = h.port({
      promptId: "int-a",
      prompt: "blocked tool",
      turnId: "turn-1",
      signal: ac.signal,
    })
    const sibling = h.port({
      promptId: "int-b",
      prompt: "other turn",
      turnId: "turn-2",
    })
    ac.abort()
    await expect(aborted).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(1)
    expect(h.resolve("int-b", { decision: "answer", text: "kept" })).toBe(true)
    await expect(sibling).resolves.toEqual({ decision: "answer", text: "kept" })
    expect(h.pendingCount()).toBe(0)
    expect(captured.filter((t) => t === "plan_user_input_resolved")).toHaveLength(2)
  })
})

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { createWebUserInputPort } from "@/apps/web-daemon/web-user-input-port"
import { bindTurnUserInput } from "@/host/runtime/internal/context-binding/turn-user-input-bind"

describe("G-F12 turn-scoped user-input cancel", () => {
  test("socket-held abort cancels one turn; late answer is a no-op", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const blocked = h.port({
      promptId: "p-abort",
      prompt: "continue?",
      sessionId: "s1",
      turnId: "turn-a",
    })
    const other = h.port({
      promptId: "p-live",
      prompt: "other?",
      sessionId: "s1",
      turnId: "turn-b",
    })
    expect(h.pendingCount()).toBe(2)
    expect(h.cancelTurn("turn-a")).toBe(1)
    expect(h.pendingCount()).toBe(1)
    await expect(blocked).resolves.toEqual({ decision: "cancelled" })
    expect(h.resolve("p-abort", { decision: "answer", text: "late" })).toBe(false)
    expect(h.resolve("p-live", { decision: "answer", text: "yes" })).toBe(true)
    await expect(other).resolves.toEqual({ decision: "answer", text: "yes" })
  })

  test("cancelAll is connection cleanup and does not replace cancelTurn", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const a = h.port({ promptId: "a", prompt: "a", turnId: "t1" })
    const b = h.port({ promptId: "b", prompt: "b", turnId: "t2" })
    h.cancelAll()
    expect(h.pendingCount()).toBe(0)
    await expect(a).resolves.toEqual({ decision: "cancelled" })
    await expect(b).resolves.toEqual({ decision: "cancelled" })
    expect(h.cancelTurn("t1")).toBe(0)
  })

  test("reusing promptId settles the stale waiter instead of leaking it", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const first = h.port({ promptId: "dup", prompt: "first", turnId: "t1" })
    const second = h.port({ promptId: "dup", prompt: "second", turnId: "t2" })
    expect(h.pendingCount()).toBe(1)
    await expect(first).resolves.toEqual({ decision: "cancelled" })
    expect(h.resolve("dup", { decision: "answer", text: "second" })).toBe(true)
    await expect(second).resolves.toEqual({ decision: "answer", text: "second" })
    expect(h.pendingCount()).toBe(0)
  })

  test("abort during stale-prompt cancel settles the replacement waiter", async () => {
    const ac = new AbortController()
    const h = createWebUserInputPort({
      capture: (ev) => {
        if (ev.type === "plan_user_input_resolved") ac.abort()
      },
    })
    const first = h.port({
      promptId: "dup",
      prompt: "first",
      turnId: "t1",
      signal: ac.signal,
    })
    const second = h.port({
      promptId: "dup",
      prompt: "second",
      turnId: "t2",
      signal: ac.signal,
    })
    await expect(first).resolves.toEqual({ decision: "cancelled" })
    await expect(second).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(0)
  })

  test("already-aborted signal settles without parking", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const ac = new AbortController()
    ac.abort()
    await expect(
      h.port({ promptId: "pre", prompt: "q", turnId: "t", signal: ac.signal }),
    ).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(0)
  })

  test("in-flight originating AbortSignal settles only that request", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const ac = new AbortController()
    const blocked = h.port({
      promptId: "sig-a",
      prompt: "blocked?",
      turnId: "turn-sig",
      signal: ac.signal,
    })
    const sibling = h.port({ promptId: "sig-b", prompt: "live?", turnId: "turn-keep" })
    expect(h.pendingCount()).toBe(2)
    ac.abort()
    await expect(blocked).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(1)
    expect(h.resolve("sig-b", { decision: "answer", text: "kept" })).toBe(true)
    await expect(sibling).resolves.toEqual({ decision: "answer", text: "kept" })
  })

  test("host bind + abort settles one request; sibling turn survives", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const ac = new AbortController()
    const cfg = bindTurnUserInput({ userInputPort: h.port } as AgentConfig, {
      sessionId: "sess-1",
      turnId: "turn-bound",
      signal: ac.signal,
    })
    const blocked = cfg.userInputPort?.({ promptId: "p-bound", prompt: "continue?" })
    const other = h.port({ promptId: "p-other", prompt: "other", turnId: "turn-other" })
    expect(h.pendingCount()).toBe(2)
    ac.abort()
    await expect(blocked).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(1)
    expect(h.resolve("p-other", { decision: "answer", text: "kept" })).toBe(true)
    await expect(other).resolves.toEqual({ decision: "answer", text: "kept" })
  })
})

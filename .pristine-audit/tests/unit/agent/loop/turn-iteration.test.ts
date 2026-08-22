/**
 * ALBB-20 #2 — applySteerBarrierMessages observability.
 *
 * Red-on-injection: `await cfg.steerBarrier()` USED to be uncaught, so a
 * throwing steer barrier crashed the whole turn. This asserts a throwing
 * barrier is caught, surfaced as a stream `error` (mirroring the sibling
 * `injectFocusChainMessage`), and the turn continues (no throw). Delete the
 * try/catch ⇒ the throw escapes and this test goes red.
 */

import { describe, expect, test } from "bun:test"
import { applySteerBarrierMessages } from "@/agent/loop/turn-iteration"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { AgentEvent } from "@/stream"
import { ToolRegistry } from "@/tool"

const baseConfig = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    llm: { stream: async function* () {} },
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

describe("turn-iteration #2 steerBarrier observability", () => {
  test("a throwing steerBarrier is caught + emitted (turn does not crash)", async () => {
    const emitted: AgentEvent[] = []
    const cfg = baseConfig({
      stream: { emit: (e) => emitted.push(e) },
      steerBarrier: async () => {
        throw new Error("barrier boom")
      },
    })
    const wm = createWorkingMemory<Message>([])

    // Must NOT throw.
    await applySteerBarrierMessages(cfg, wm)

    const err = emitted.find((e) => e.type === "error")
    expect(err).toBeDefined()
    if (err?.type === "error") expect(err.message).toContain("steer barrier failed")
    if (err?.type === "error") expect(err.message).toContain("barrier boom")
  })

  test("a well-behaved steerBarrier still drains injected messages", async () => {
    const cfg = baseConfig({})
    cfg.steerBarrier = async () => {
      cfg.messages.push({ role: "user", content: [{ type: "text", text: "steered" }] })
    }
    const wm = createWorkingMemory<Message>([])
    await applySteerBarrierMessages(cfg, wm)
    expect(wm.snapshot().at(-1)?.content[0]).toEqual({ type: "text", text: "steered" })
  })
})

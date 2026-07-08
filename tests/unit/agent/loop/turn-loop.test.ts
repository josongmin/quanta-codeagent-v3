/**
 * ALBB-20 #9 — turn-observability flush failure emits a stream event.
 *
 * Red-on-injection: the flush failure USED to be warn-only, so a UI watching
 * the stream sink never learned turn telemetry was dropped. This drives
 * `executeTurnWithObservability` with a `turnDiffSession.endTurn` that throws
 * (the flush path) and asserts a non-fatal stream `error` is emitted alongside
 * the warn. Delete the emit ⇒ this goes red.
 */

import { describe, expect, test } from "bun:test"
import { executeTurnWithObservability } from "@/agent/loop/turn-loop"
import type { RunAgentContext } from "@/agent/loop/types"
import type { TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { AgentEvent } from "@/stream"
import { ToolRegistry } from "@/tool"

describe("turn-loop #9 flush-failure stream emit", () => {
  test("a throwing turn-observability flush emits a non-fatal stream error", async () => {
    const emitted: AgentEvent[] = []
    const registry = new ToolRegistry([])
    const config = {
      llm: {
        // Empty stream ⇒ runTurn assembles an empty turn and terminates fast.
        stream: async function* () {},
      },
      registry,
      stream: { emit: (e: AgentEvent) => emitted.push(e) },
      permission: { mode: "default" },
      messages: [],
      system: "",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
    } as unknown as AgentConfig

    const session: TurnSession = {
      config,
      specs: registry.specs(),
      guards: [],
    }
    const turnStateSeed = {
      wm: createWorkingMemory<Message>([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
      breaker: undefined,
      toolHistory: undefined,
      workingState: undefined,
      toolChoiceState: {} as TurnState["toolChoiceState"],
      citations: [],
      onRedaction: () => {},
      onTurnTiming: undefined,
    } as unknown as RunAgentContext["turnStateSeed"]

    const ctx = {
      cfg: config,
      session,
      turnStateSeed,
      // The flush path calls endTurn — throwing here exercises the catch.
      turnDiffSession: {
        startTurn: async () => {},
        endTurn: async () => {
          throw new Error("flush boom")
        },
      },
      gitDirectiveCollector: undefined,
    } as unknown as RunAgentContext

    await executeTurnWithObservability({ ctx, turn: 1 })

    const flushErr = emitted.find(
      (e) => e.type === "error" && e.message.includes("turn observability flush failed"),
    )
    expect(flushErr).toBeDefined()
    if (flushErr?.type === "error") expect(flushErr.message).toContain("flush boom")
  })
})

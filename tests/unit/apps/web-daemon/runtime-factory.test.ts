import { describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { StreamEvent, StreamInput } from "@/llm"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { ToolRegistry } from "@/tool"

type LLMPort = import("@/llm").LLMPort

class StreamingStubLLM implements LLMPort {
  readonly model = "stub-model"

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "po" }
    yield { type: "text_delta", delta: "ng" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("web-daemon runtime factory", () => {
  test("interactive turn assembler preserves the runtime turn stream override", async () => {
    const abort = new AbortController()
    const base = {
      llm: new StreamingStubLLM(),
      registry: new ToolRegistry([]),
      stream: new StdoutStream(),
      permission: { mode: "default" as const },
      messages: [],
      system: "system",
      cwd: "/tmp/quanta-web-daemon",
      maxTurns: 8,
      signal: abort.signal,
    }

    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const session = await runtime.createSession({ cwd: base.cwd, permissionMode: "default" })

    const seen: string[] = []
    const off = session.subscribe((event) => {
      seen.push(event.type)
    })

    await session.input.append("ping")
    const turn = await session.turn.run()

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.state.updated",
      "turn.llm.request",
      "turn.output.delta",
      "turn.output.delta",
      "turn.completed",
      "session.state.updated",
    ])
    expect(seen).toContain("turn.llm.request")
    expect(seen).toContain("turn.output.delta")
    expect((await session.snapshot()).state.lastAssistantText).toBe("pong")

    off()
    await session.close()
    await runtime.close()
  })
})

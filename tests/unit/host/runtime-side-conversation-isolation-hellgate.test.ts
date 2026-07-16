import { describe, expect, test } from "bun:test"
import {
  buildIsolatedSideConversationConfig,
  startSideConversation,
} from "@/host/runtime/internal/context-binding/side-conversation"
import type { RuntimeBase } from "@/host/runtime/internal/context-binding/types"
import { ToolRegistry } from "@/tool"

const signal = new AbortController().signal

const makeBase = (onPromptAssembled: () => void): RuntimeBase =>
  ({
    llm: {
      async *stream() {
        yield { type: "text_delta", delta: "isolated answer" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    },
    registry: new ToolRegistry([]),
    stream: { emit: () => undefined },
    permission: { mode: "default" },
    messages: [],
    system: "main system",
    cwd: "/tmp",
    maxTurns: 12,
    signal,
    onPromptAssembled,
    radar: { store: { proposeCard: () => ({}) } } as never,
    objective: { mutable: true },
    store: { mutable: true } as never,
    approvalStateMachine: { mutable: true } as never,
  }) as unknown as RuntimeBase

describe("runtime side conversation isolation", () => {
  test("explicit allowlist excludes parent hooks and mutable stores", () => {
    const config = buildIsolatedSideConversationConfig({
      base: makeBase(() => undefined),
      registry: new ToolRegistry([]),
      stream: { emit: () => undefined },
      messages: [],
      signal,
      maxTurns: 3,
    })

    expect(config.onPromptAssembled).toBeUndefined()
    expect(config.radar).toBeUndefined()
    expect(config.objective).toBeUndefined()
    expect(config.store).toBeUndefined()
    expect(config.approvalStateMachine).toBeUndefined()
  })

  test("live side chat does not inherit parent hooks or mutable stores", async () => {
    let parentPromptHookCalls = 0
    const result = await startSideConversation({
      base: makeBase(() => {
        parentPromptHookCalls += 1
      }),
      question: "what changed?",
      messages: [],
      signal,
    })

    expect(result.answerText).toBe("isolated answer")
    expect(parentPromptHookCalls).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import {
  defaultResponsesContinuationStore,
  type LLMPort,
  responsesContinuationLlmPort,
  type StreamEvent,
  type StreamInput,
} from "@/llm"

describe("responsesContinuationLlmPort", () => {
  test("injects the store when absent and preserves route metadata", async () => {
    const seen: StreamInput[] = []
    const inner: LLMPort = {
      model: "gpt-5",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      authMode: "OpenAI BYOK",
      stream: (input: StreamInput): AsyncIterable<StreamEvent> => ({
        async *[Symbol.asyncIterator]() {
          seen.push(input)
          yield* []
        },
      }),
    }
    const store = defaultResponsesContinuationStore()
    const wrapped = responsesContinuationLlmPort({ inner, store })

    expect(wrapped.model).toBe("gpt-5")
    expect(wrapped.surfaceId).toBe("openai-responses")
    for await (const _ of wrapped.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    })) {
      // drain
    }

    expect(seen[0]?.responsesContinuation?.store).toBe(store)
  })

  test("does not overwrite a pre-existing store on the input", async () => {
    const seen: StreamInput[] = []
    const inner: LLMPort = {
      stream: (input: StreamInput): AsyncIterable<StreamEvent> => ({
        async *[Symbol.asyncIterator]() {
          seen.push(input)
          yield* []
        },
      }),
    }
    const storeA = defaultResponsesContinuationStore()
    const storeB = defaultResponsesContinuationStore()
    const wrapped = responsesContinuationLlmPort({ inner, store: storeA })

    for await (const _ of wrapped.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      responsesContinuation: { store: storeB },
    })) {
      // drain
    }

    expect(seen[0]?.responsesContinuation?.store).toBe(storeB)
  })
})

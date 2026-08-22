import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import type { StreamInput } from "@/llm/types"

type ChatCompletionsCreate = typeof OpenAI.prototype.chat.completions.create

// A minimal but COMPLETE chat-completions stream: a real response always closes
// with a `finish_reason`. A truly-empty stream now trips the empty-stream circuit
// breaker ("no content and no finish_reason"), which would throw before we can
// capture the request params these tests assert on.
const terminalStream = (): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  },
})

const baseInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})

describe("OpenAIAdapter prompt cache routing", () => {
  test("forwards prompt_cache_key and prompt_cache_retention to Chat Completions", async () => {
    const adapter = new OpenAIAdapter({ apiKey: "k", model: "gpt-5-mini" })
    let params: Record<string, unknown> | undefined
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    ;(adapter as any).client = {
      chat: {
        completions: {
          create: (async (p: Record<string, unknown>) => {
            params = p
            return terminalStream()
          }) as unknown as ChatCompletionsCreate,
        },
      },
    }

    for await (const _ of adapter.stream({
      ...baseInput(),
      promptCacheKey: "thread-99",
      promptCacheRetention: "24h",
    })) {
      // drain
    }

    expect(params?.prompt_cache_key).toBe("thread-99")
    expect(params?.prompt_cache_retention).toBe("24h")
  })
})
